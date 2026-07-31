import Redis from 'ioredis';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../config/logger';
import {
  bidsProcessedCounter,
  bidLatencyHistogram,
  redisLuaLatencyHistogram,
  postgresPersistLatencyHistogram,
  softCloseExtensionsCounter,
} from '../config/metrics';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------
export interface PlaceBidRequest {
  auctionId: string;
  bidderId: string;
  amountCents: number;
  ipAddress?: string;
  userAgent?: string;
}

export interface BidResult {
  success: boolean;
  error?: string;
  message?: string;
  bidAmount?: number;
  version?: number;
  totalBids?: number;
  previousBidder?: string;
  extended?: boolean;
  newEndTimeMs?: number;
  correlationId?: string;
  currentHighest?: number;
  minimumRequired?: number;
}

// ---------------------------------------------------------------------------
// BiddingEngine with Full Prometheus & Correlation ID Lifecycle Observability
// ---------------------------------------------------------------------------
export class BiddingEngine {
  private redis: Redis;
  private pool: Pool;
  private luaScript: string;
  private luaScriptSha: string | null = null;

  constructor(redis: Redis, pool: Pool) {
    this.redis = redis;
    this.pool = pool;

    const luaPath = path.resolve(__dirname, '../lua/place-bid.lua');
    this.luaScript = fs.readFileSync(luaPath, 'utf-8');
  }

  async initialize(): Promise<void> {
    this.luaScriptSha = (await this.redis.script('LOAD', this.luaScript)) as string;
    logger.info({ sha: this.luaScriptSha }, 'Bid Lua script loaded into Redis');
  }

  // -----------------------------------------------------------------------
  // Core: Place a bid with metric timing & correlation tracking
  // -----------------------------------------------------------------------
  async placeBid(req: PlaceBidRequest): Promise<BidResult> {
    const correlationId = uuidv4();
    const startTimeSeconds = process.hrtime.bigint();
    const nowMs = Date.now();
    const redisKey = `auction:${req.auctionId}`;

    const log = logger.child({
      correlationId,
      auctionId: req.auctionId,
      bidderId: req.bidderId,
      amountCents: req.amountCents,
    });

    log.info('--> [Bid Lifecycle Start] Processing bid request');

    // ------------------------------------------------------------------
    // Phase 1: Atomic Redis Lua Evaluation (Timings & Metric Export)
    // ------------------------------------------------------------------
    const luaStart = process.hrtime.bigint();
    let rawResult: string;

    try {
      if (this.luaScriptSha) {
        rawResult = (await this.redis.evalsha(
          this.luaScriptSha,
          1,
          redisKey,
          req.bidderId,
          req.amountCents.toString(),
          nowMs.toString(),
          correlationId
        )) as string;
      } else {
        rawResult = (await this.redis.eval(
          this.luaScript,
          1,
          redisKey,
          req.bidderId,
          req.amountCents.toString(),
          nowMs.toString(),
          correlationId
        )) as string;
      }
    } catch (err) {
      log.error({ err }, 'Redis Lua script execution error');
      bidsProcessedCounter.inc({ status: 'rejected', error_code: 'INTERNAL_ERROR' });
      return { success: false, error: 'INTERNAL_ERROR', message: 'Bid processing failed' };
    } finally {
      const luaEnd = process.hrtime.bigint();
      const luaDurationSec = Number(luaEnd - luaStart) / 1e9;
      redisLuaLatencyHistogram.observe(luaDurationSec);
    }

    const result: BidResult = this.parseRedisResult(rawResult);
    result.correlationId = correlationId;

    if (!result.success) {
      log.warn(
        { errorCode: result.error, message: result.message },
        '<-- [Bid Lifecycle End] Bid rejected by Redis'
      );
      bidsProcessedCounter.inc({ status: 'rejected', error_code: result.error || 'UNKNOWN' });

      // Observe overall latency
      const totalSec = Number(process.hrtime.bigint() - startTimeSeconds) / 1e9;
      bidLatencyHistogram.observe(totalSec);

      return result;
    }

    // Record successful evaluation
    bidsProcessedCounter.inc({ status: 'accepted', error_code: 'none' });
    if (result.extended) {
      softCloseExtensionsCounter.inc();
      log.info({ newEndTimeMs: result.newEndTimeMs }, 'Soft-close extension triggered');
    }

    log.info(
      { version: result.version, totalBids: result.totalBids, extended: result.extended },
      '--> [Bid Accepted by Redis] Initiating PostgreSQL write-behind'
    );

    // ------------------------------------------------------------------
    // Phase 2: Persist to PostgreSQL (Metrics & Correlation ID tracking)
    // ------------------------------------------------------------------
    const pgStart = process.hrtime.bigint();
    try {
      await this.persistBidToPostgres(req, result, correlationId);
      log.info('<-- [Bid Lifecycle End] Bid successfully persisted to PostgreSQL');
    } catch (err) {
      log.error({ err }, 'PostgreSQL persistence failed — state held in Redis');
    } finally {
      const pgEnd = process.hrtime.bigint();
      const pgDurationSec = Number(pgEnd - pgStart) / 1e9;
      postgresPersistLatencyHistogram.observe(pgDurationSec);
    }

    // Observe total latency
    const totalSec = Number(process.hrtime.bigint() - startTimeSeconds) / 1e9;
    bidLatencyHistogram.observe(totalSec);

    return result;
  }

  // -----------------------------------------------------------------------
  // Persist bid to PostgreSQL
  // -----------------------------------------------------------------------
  private async persistBidToPostgres(
    req: PlaceBidRequest,
    result: BidResult,
    correlationId: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO bids (
           auction_id, bidder_id, amount_cents, status,
           auction_version_at_bid, ip_address, user_agent, correlation_id
         ) VALUES ($1, $2, $3, 'valid', $4, $5, $6, $7)`,
        [
          req.auctionId,
          req.bidderId,
          req.amountCents,
          result.version,
          req.ipAddress || null,
          req.userAgent || null,
          correlationId,
        ]
      );

      if (result.previousBidder) {
        await client.query(
          `UPDATE bids SET status = 'outbid'
           WHERE auction_id = $1
             AND bidder_id = $2
             AND status = 'valid'
             AND amount_cents < $3`,
          [req.auctionId, result.previousBidder, req.amountCents]
        );
      }

      const expectedVersion = (result.version ?? 1) - 1;
      const updateResult = await client.query(
        `UPDATE auctions SET
           current_highest_bid_cents   = $1,
           current_highest_bidder_id   = $2,
           total_bids                  = $3,
           version                     = $4,
           current_end_time            = to_timestamp($5::double precision / 1000),
           status                      = CASE
                                           WHEN $6 = true THEN 'soft_close'::auction_status
                                           ELSE status
                                         END,
           updated_at                  = NOW()
         WHERE id = $7 AND version = $8`,
        [
          req.amountCents,
          req.bidderId,
          result.totalBids,
          result.version,
          result.newEndTimeMs,
          result.extended ?? false,
          req.auctionId,
          expectedVersion,
        ]
      );

      if (updateResult.rowCount === 0) {
        logger.warn(
          { correlationId, auctionId: req.auctionId, expectedVersion },
          'Optimistic lock conflict during Postgres write-behind'
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // -----------------------------------------------------------------------
  // Parse Redis Result
  // -----------------------------------------------------------------------
  private parseRedisResult(raw: string): BidResult {
    try {
      const parsed = JSON.parse(raw);
      return {
        success: parsed.success,
        error: parsed.error,
        message: parsed.message,
        bidAmount: parsed.bid_amount,
        version: parsed.version,
        totalBids: parsed.total_bids,
        previousBidder: parsed.previous_bidder,
        extended: parsed.extended,
        newEndTimeMs: parsed.new_end_time_ms,
        currentHighest: parsed.current_highest,
        minimumRequired: parsed.minimum_required,
      };
    } catch {
      return { success: false, error: 'PARSE_ERROR', message: 'Failed to parse Redis response' };
    }
  }
}
