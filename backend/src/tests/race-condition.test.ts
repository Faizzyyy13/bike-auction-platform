/**
 * ============================================================================
 * Race Condition Test — Concurrent Bid Serialization
 * ============================================================================
 *
 * This test proves that when two (or more) bids arrive simultaneously for the
 * same auction at the same amount, the Redis Lua script serializes them
 * atomically: exactly ONE bid is accepted, ALL others are rejected with
 * BID_TOO_LOW.
 *
 * The test uses a real Redis instance (required) but mocks PostgreSQL since
 * we're testing the Redis concurrency layer specifically.
 *
 * Run:  npm run test:race
 * ============================================================================
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const TEST_AUCTION_ID = 'test-auction-race-001';
const SELLER_ID = 'seller-aaa-111';
const BIDDER_A = 'bidder-aaa-111';
const BIDDER_B = 'bidder-bbb-222';
const BIDDER_C = 'bidder-ccc-333';
const REDIS_KEY = `auction:${TEST_AUCTION_ID}`;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let redis: Redis;
let luaScript: string;
let luaScriptSha: string;

beforeAll(async () => {
  redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 1 });

  // Load the Lua script
  const luaPath = path.resolve(__dirname, '../lua/place-bid.lua');
  luaScript = fs.readFileSync(luaPath, 'utf-8');

  // Pre-load script into Redis
  luaScriptSha = (await redis.script('LOAD', luaScript)) as string;
});

afterAll(async () => {
  await redis.del(REDIS_KEY);
  await redis.quit();
});

// ---------------------------------------------------------------------------
// Helper: seed auction state in Redis
// ---------------------------------------------------------------------------
async function seedAuction(overrides: Partial<Record<string, string>> = {}): Promise<void> {
  await redis.del(REDIS_KEY);

  const defaults: Record<string, string> = {
    current_highest_bid_cents: '10000', // $100.00
    current_highest_bidder_id: '',
    seller_id: SELLER_ID,
    bid_increment_cents: '100', // $1.00 minimum increment
    current_end_time_ms: (Date.now() + 600_000).toString(), // 10 min from now
    soft_close_window_ms: '120000',
    soft_close_extension_ms: '120000',
    total_bids: '0',
    status: 'active',
    version: '1',
  };

  const state = { ...defaults, ...overrides };
  await redis.hset(REDIS_KEY, state);
}

// ---------------------------------------------------------------------------
// Helper: execute bid via Lua script
// ---------------------------------------------------------------------------
async function executeBid(
  bidderId: string,
  amountCents: number,
  nowMs?: number
): Promise<any> {
  const result = (await redis.evalsha(
    luaScriptSha,
    1,
    REDIS_KEY,
    bidderId,
    amountCents.toString(),
    (nowMs || Date.now()).toString(),
    `corr-${bidderId}-${amountCents}`
  )) as string;

  return JSON.parse(result);
}

// ===========================================================================
// TEST SUITE
// ===========================================================================
describe('Bidding Engine — Race Condition Prevention', () => {
  beforeEach(async () => {
    await seedAuction();
  });

  // -----------------------------------------------------------------------
  // TEST 1: Two simultaneous bids at the same amount — only ONE wins
  // -----------------------------------------------------------------------
  it('should accept exactly one of two concurrent bids at the same amount', async () => {
    // Both bidders try to place $110.00 (10100 cents) concurrently.
    // Current highest is $100.00 (10000 cents), increment is $1.00 (100 cents).
    // Minimum valid bid: $101.00 (10100 cents).

    const bidAmount = 10100; // $101.00
    const nowMs = Date.now();

    // Fire both bids simultaneously — Promise.all ensures they're dispatched
    // at the same time and hit the Redis Lua script concurrently.
    const [resultA, resultB] = await Promise.all([
      executeBid(BIDDER_A, bidAmount, nowMs),
      executeBid(BIDDER_B, bidAmount, nowMs),
    ]);

    // Exactly ONE should succeed
    const successes = [resultA, resultB].filter((r) => r.success);
    const failures = [resultA, resultB].filter((r) => !r.success);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // The winner should have the correct version
    expect(successes[0].version).toBe(2);
    expect(successes[0].bid_amount).toBe(bidAmount);

    // The loser should get BID_TOO_LOW (because the winner already raised it)
    expect(failures[0].error).toBe('BID_TOO_LOW');

    // Verify Redis state is consistent
    const state = await redis.hgetall(REDIS_KEY);
    expect(parseInt(state.current_highest_bid_cents)).toBe(bidAmount);
    expect(parseInt(state.version)).toBe(2);
    expect(parseInt(state.total_bids)).toBe(1);

    console.log('\n✅ Race Condition Test 1 PASSED:');
    console.log(`   Winner: ${successes[0].correlation_id}`);
    console.log(`   Loser:  ${failures[0].error} — "${failures[0].message}"`);
  });

  // -----------------------------------------------------------------------
  // TEST 2: Three concurrent bids at ascending amounts — all accepted in order
  // -----------------------------------------------------------------------
  it('should correctly serialize three concurrent bids at different amounts', async () => {
    const nowMs = Date.now();

    // Three bids: $101, $102, $103 — all valid but arrive concurrently
    const [r1, r2, r3] = await Promise.all([
      executeBid(BIDDER_A, 10100, nowMs), // $101.00
      executeBid(BIDDER_B, 10200, nowMs), // $102.00
      executeBid(BIDDER_C, 10300, nowMs), // $103.00
    ]);

    const results = [r1, r2, r3];
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    // Due to Redis single-threaded execution, bids are serialized.
    // The first one processed wins at its amount. Subsequent ones
    // are evaluated against the NEW highest bid.
    // At least 1 must succeed. Some may fail if the serialization
    // order means a lower bid arrives after a higher one.
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // The final Redis state must reflect a valid bid
    const state = await redis.hgetall(REDIS_KEY);
    const finalBid = parseInt(state.current_highest_bid_cents);
    expect(finalBid).toBeGreaterThanOrEqual(10100);
    expect(parseInt(state.version)).toBe(1 + successes.length);

    console.log('\n✅ Race Condition Test 2 PASSED:');
    console.log(`   Accepted: ${successes.length} bids`);
    console.log(`   Rejected: ${failures.length} bids`);
    console.log(`   Final highest bid: $${(finalBid / 100).toFixed(2)}`);
  });

  // -----------------------------------------------------------------------
  // TEST 3: Shill bidding prevention — seller cannot bid
  // -----------------------------------------------------------------------
  it('should reject bid from the auction seller (anti-shill)', async () => {
    const result = await executeBid(SELLER_ID, 10100);

    expect(result.success).toBe(false);
    expect(result.error).toBe('SHILL_BID_REJECTED');

    console.log('\n✅ Shill Bidding Test PASSED: Seller bid rejected');
  });

  // -----------------------------------------------------------------------
  // TEST 4: Bid on ended auction is rejected
  // -----------------------------------------------------------------------
  it('should reject bid on an auction that has ended', async () => {
    // Seed auction with end_time in the past
    await seedAuction({
      current_end_time_ms: (Date.now() - 1000).toString(),
    });

    const result = await executeBid(BIDDER_A, 10100);

    expect(result.success).toBe(false);
    expect(result.error).toBe('AUCTION_ENDED');

    console.log('\n✅ Ended Auction Test PASSED: Bid on expired auction rejected');
  });

  // -----------------------------------------------------------------------
  // TEST 5: Bid below minimum increment is rejected
  // -----------------------------------------------------------------------
  it('should reject bid below the minimum increment', async () => {
    const result = await executeBid(BIDDER_A, 10050); // $100.50 — below $101.00 minimum

    expect(result.success).toBe(false);
    expect(result.error).toBe('BID_TOO_LOW');
    expect(result.minimum_required).toBe(10100);

    console.log('\n✅ Minimum Increment Test PASSED: Sub-threshold bid rejected');
  });

  // -----------------------------------------------------------------------
  // TEST 6: Soft-close extension triggers correctly
  // -----------------------------------------------------------------------
  it('should extend auction end time when bid placed in soft-close window', async () => {
    const softCloseWindowMs = 120_000; // 2 minutes
    const extensionMs = 120_000; // extends by 2 minutes
    const originalEndMs = Date.now() + 60_000; // 1 minute remaining (within window)

    await seedAuction({
      current_end_time_ms: originalEndMs.toString(),
      soft_close_window_ms: softCloseWindowMs.toString(),
      soft_close_extension_ms: extensionMs.toString(),
    });

    const result = await executeBid(BIDDER_A, 10100);

    expect(result.success).toBe(true);
    expect(result.extended).toBe(true);
    expect(result.new_end_time_ms).toBe(originalEndMs + extensionMs);

    // Verify Redis state
    const state = await redis.hgetall(REDIS_KEY);
    expect(state.status).toBe('soft_close');
    expect(parseInt(state.current_end_time_ms)).toBe(originalEndMs + extensionMs);

    console.log('\n✅ Soft-Close Extension Test PASSED:');
    console.log(`   Original end: ${new Date(originalEndMs).toISOString()}`);
    console.log(`   Extended to:  ${new Date(originalEndMs + extensionMs).toISOString()}`);
  });

  // -----------------------------------------------------------------------
  // TEST 7: High-contention stress test — 10 concurrent bids
  // -----------------------------------------------------------------------
  it('should maintain consistency under 10 concurrent bids', async () => {
    const nowMs = Date.now();
    const bidders = Array.from({ length: 10 }, (_, i) => `stress-bidder-${i}`);

    // All 10 bidders try to place the exact same bid amount
    const bidAmount = 10100;
    const results = await Promise.all(
      bidders.map((bidderId) => executeBid(bidderId, bidAmount, nowMs))
    );

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    // Exactly ONE must win
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(9);

    // All failures must be BID_TOO_LOW
    for (const fail of failures) {
      expect(fail.error).toBe('BID_TOO_LOW');
    }

    // Redis state must be consistent
    const state = await redis.hgetall(REDIS_KEY);
    expect(parseInt(state.current_highest_bid_cents)).toBe(bidAmount);
    expect(parseInt(state.total_bids)).toBe(1);
    expect(parseInt(state.version)).toBe(2);

    console.log('\n✅ Stress Test PASSED:');
    console.log(`   10 concurrent bids, 1 winner, 9 rejected`);
    console.log(`   Winner: ${successes[0].correlation_id}`);
  });
});
