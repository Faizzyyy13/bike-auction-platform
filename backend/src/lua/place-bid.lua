-- ============================================================================
-- place-bid.lua — Atomic Bid Evaluation & State Update
-- ============================================================================
-- Runs inside Redis as a single atomic operation (no other command can
-- interleave). This guarantees that two concurrent bids are serialized:
-- exactly one wins, the other gets a deterministic rejection.
--
-- KEYS[1] = auction:{auctionId}          (Hash)
-- ARGV[1] = bidder_id                    (string UUID)
-- ARGV[2] = bid_amount_cents             (integer as string)
-- ARGV[3] = current_timestamp_ms         (epoch ms)
-- ARGV[4] = correlation_id              (string UUID)
--
-- Hash fields on KEYS[1]:
--   current_highest_bid_cents   (string integer)
--   current_highest_bidder_id   (string UUID)
--   seller_id                   (string UUID)
--   bid_increment_cents         (string integer)
--   current_end_time_ms         (epoch ms)
--   soft_close_window_ms        (ms)
--   soft_close_extension_ms     (ms)
--   total_bids                  (string integer)
--   status                      (string: "active" | "soft_close")
--   version                     (string integer)
--
-- Returns: JSON-encoded result object
-- ============================================================================

local key = KEYS[1]
local bidder_id       = ARGV[1]
local bid_amount      = tonumber(ARGV[2])
local now_ms          = tonumber(ARGV[3])
local correlation_id  = ARGV[4]

-- -------------------------------------------------------
-- 1. Load auction state from the hash
-- -------------------------------------------------------
local auction = redis.call('HGETALL', key)
if #auction == 0 then
  return cjson.encode({
    success = false,
    error   = 'AUCTION_NOT_FOUND',
    message = 'Auction does not exist in cache'
  })
end

-- Parse hash into a table
local state = {}
for i = 1, #auction, 2 do
  state[auction[i]] = auction[i + 1]
end

-- -------------------------------------------------------
-- 2. Validate auction is active
-- -------------------------------------------------------
local status = state['status']
if status ~= 'active' and status ~= 'soft_close' then
  return cjson.encode({
    success = false,
    error   = 'AUCTION_NOT_ACTIVE',
    message = 'Auction status is: ' .. tostring(status)
  })
end

-- -------------------------------------------------------
-- 3. Validate auction has not ended
-- -------------------------------------------------------
local end_time_ms = tonumber(state['current_end_time_ms'])
if now_ms >= end_time_ms then
  return cjson.encode({
    success = false,
    error   = 'AUCTION_ENDED',
    message = 'Auction has already ended'
  })
end

-- -------------------------------------------------------
-- 4. Anti-shill: bidder cannot be the seller
-- -------------------------------------------------------
local seller_id = state['seller_id']
if bidder_id == seller_id then
  return cjson.encode({
    success = false,
    error   = 'SHILL_BID_REJECTED',
    message = 'Seller cannot bid on own auction'
  })
end

-- -------------------------------------------------------
-- 5. Validate bid amount meets minimum
-- -------------------------------------------------------
local current_highest  = tonumber(state['current_highest_bid_cents']) or 0
local bid_increment    = tonumber(state['bid_increment_cents']) or 100
local minimum_required = current_highest + bid_increment

if bid_amount < minimum_required then
  return cjson.encode({
    success          = false,
    error            = 'BID_TOO_LOW',
    message          = 'Bid must be at least ' .. tostring(minimum_required),
    current_highest  = current_highest,
    minimum_required = minimum_required
  })
end

-- -------------------------------------------------------
-- 6. SUCCESS — Atomically update auction state
-- -------------------------------------------------------
local old_bidder     = state['current_highest_bidder_id'] or ''
local old_version    = tonumber(state['version']) or 1
local new_version    = old_version + 1
local new_total_bids = (tonumber(state['total_bids']) or 0) + 1

redis.call('HSET', key,
  'current_highest_bid_cents',  tostring(bid_amount),
  'current_highest_bidder_id',  bidder_id,
  'total_bids',                 tostring(new_total_bids),
  'version',                    tostring(new_version)
)

-- -------------------------------------------------------
-- 7. Soft-close extension check
-- -------------------------------------------------------
local soft_close_window_ms    = tonumber(state['soft_close_window_ms']) or 120000
local soft_close_extension_ms = tonumber(state['soft_close_extension_ms']) or 120000
local time_remaining_ms       = end_time_ms - now_ms
local extended                = false
local new_end_time_ms         = end_time_ms

if time_remaining_ms <= soft_close_window_ms then
  new_end_time_ms = end_time_ms + soft_close_extension_ms
  redis.call('HSET', key,
    'current_end_time_ms', tostring(new_end_time_ms),
    'status',              'soft_close'
  )
  extended = true
end

-- -------------------------------------------------------
-- 8. Publish bid event for WebSocket broadcast
-- -------------------------------------------------------
local event = cjson.encode({
  type             = 'NEW_BID',
  auction_id       = key:gsub('auction:', ''),
  bidder_id        = bidder_id,
  amount_cents     = bid_amount,
  previous_bidder  = old_bidder,
  total_bids       = new_total_bids,
  version          = new_version,
  end_time_ms      = new_end_time_ms,
  extended         = extended,
  correlation_id   = correlation_id,
  timestamp_ms     = now_ms
})
redis.call('PUBLISH', 'auction:events', event)

-- -------------------------------------------------------
-- 9. Return success payload
-- -------------------------------------------------------
return cjson.encode({
  success          = true,
  bid_amount       = bid_amount,
  version          = new_version,
  total_bids       = new_total_bids,
  previous_bidder  = old_bidder,
  extended         = extended,
  new_end_time_ms  = new_end_time_ms,
  correlation_id   = correlation_id
})
