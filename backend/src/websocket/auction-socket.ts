import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { logger } from '../config/logger';
import { BiddingEngine, PlaceBidRequest } from '../services/bidding-engine';
import { activeConnectionsGauge, bidsProcessedCounter } from '../config/metrics';

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------
interface RateLimitEntry {
  timestamps: number[];
}

const RATE_LIMIT_MAX_BIDS = 5;
const RATE_LIMIT_WINDOW_MS = 10_000;

class BidRateLimiter {
  private entries = new Map<string, RateLimitEntry>();

  isAllowed(userId: string, auctionId: string): boolean {
    const key = `${userId}:${auctionId}`;
    const now = Date.now();
    const entry = this.entries.get(key) || { timestamps: [] };

    entry.timestamps = entry.timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);

    if (entry.timestamps.length >= RATE_LIMIT_MAX_BIDS) {
      return false;
    }

    entry.timestamps.push(now);
    this.entries.set(key, entry);
    return true;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
      if (entry.timestamps.length === 0) {
        this.entries.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AuctionSocketServer with Prometheus Connections Tracking
// ---------------------------------------------------------------------------
export class AuctionSocketServer {
  private io: Server;
  private biddingEngine: BiddingEngine;
  private redisSubscriber: Redis;
  private rateLimiter: BidRateLimiter;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(httpServer: HttpServer, biddingEngine: BiddingEngine, redisSubscriber: Redis) {
    this.biddingEngine = biddingEngine;
    this.redisSubscriber = redisSubscriber;
    this.rateLimiter = new BidRateLimiter();

    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
        credentials: true,
      },
      pingTimeout: 60_000,
      pingInterval: 25_000,
    });

    this.setupRedisSubscription();
    this.setupConnectionHandler();

    this.cleanupInterval = setInterval(() => this.rateLimiter.cleanup(), 30_000);
  }

  private setupRedisSubscription(): void {
    this.redisSubscriber.subscribe('auction:events', (err) => {
      if (err) {
        logger.error({ err }, 'Failed to subscribe to auction:events');
        return;
      }
      logger.info('Subscribed to Redis channel: auction:events');
    });

    this.redisSubscriber.on('message', (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message);
        const room = `auction:${event.auction_id}`;

        this.io.to(room).emit('bid:update', {
          type: event.type,
          auctionId: event.auction_id,
          bidderId: event.bidder_id,
          amountCents: event.amount_cents,
          totalBids: event.total_bids,
          version: event.version,
          endTimeMs: event.end_time_ms,
          extended: event.extended,
          correlationId: event.correlation_id,
          timestamp: event.timestamp_ms,
        });

        if (event.previous_bidder && event.previous_bidder !== event.bidder_id) {
          this.io.to(`user:${event.previous_bidder}`).emit('bid:outbid', {
            auctionId: event.auction_id,
            newHighestBid: event.amount_cents,
            correlationId: event.correlation_id,
          });
        }
      } catch (err) {
        logger.error({ err, message }, 'Failed to broadcast Redis event');
      }
    });
  }

  private setupConnectionHandler(): void {
    this.io.use((socket, next) => {
      const userId = socket.handshake.auth?.userId;
      if (!userId) {
        return next(new Error('Authentication required'));
      }
      (socket as any).userId = userId;
      next();
    });

    this.io.on('connection', (socket: Socket) => {
      const userId = (socket as any).userId as string;

      // Update Prometheus Active Connections Gauge
      activeConnectionsGauge.inc();

      logger.info({ socketId: socket.id, userId }, 'Client connected');
      socket.join(`user:${userId}`);

      socket.on('auction:join', (data: { auctionId: string }) => {
        socket.join(`auction:${data.auctionId}`);
      });

      socket.on('auction:leave', (data: { auctionId: string }) => {
        socket.leave(`auction:${data.auctionId}`);
      });

      socket.on('bid:place', async (data: { auctionId: string; amountCents: number }, callback?: (response: any) => void) => {
        if (!this.rateLimiter.isAllowed(userId, data.auctionId)) {
          bidsProcessedCounter.inc({ status: 'rate_limited', error_code: 'RATE_LIMITED' });
          const rejection = {
            success: false,
            error: 'RATE_LIMITED',
            message: 'Too many bids — please wait before bidding again',
          };
          if (callback) callback(rejection);
          return;
        }

        const request: PlaceBidRequest = {
          auctionId: data.auctionId,
          bidderId: userId,
          amountCents: data.amountCents,
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent'],
        };

        const result = await this.biddingEngine.placeBid(request);
        if (callback) callback(result);
      });

      socket.on('disconnect', () => {
        // Decrement Prometheus Active Connections Gauge
        activeConnectionsGauge.dec();
        logger.info({ socketId: socket.id, userId }, 'Client disconnected');
      });
    });
  }

  getIO(): Server {
    return this.io;
  }

  async shutdown(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    await this.redisSubscriber.unsubscribe('auction:events');
    this.io.close();
  }
}
