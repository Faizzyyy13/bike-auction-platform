import client from 'prom-client';

// ---------------------------------------------------------------------------
// Prometheus Registry Initialization
// ---------------------------------------------------------------------------
export const register = new client.Registry();

// Enable default system metrics (CPU, Memory, Event Loop Lag)
client.collectDefaultMetrics({
  register,
  prefix: 'bike_auction_system_',
});

// ---------------------------------------------------------------------------
// Custom Domain Metrics
// ---------------------------------------------------------------------------

/** Gauge: Current active WebSocket client connections */
export const activeConnectionsGauge = new client.Gauge({
  name: 'bike_auction_active_websocket_connections',
  help: 'Number of currently active WebSocket client connections',
});
register.registerMetric(activeConnectionsGauge);

/** Counter: Total bids processed, partitioned by outcome status */
export const bidsProcessedCounter = new client.Counter({
  name: 'bike_auction_bids_processed_total',
  help: 'Total count of bid requests processed by the engine',
  labelNames: ['status', 'error_code'] as const,
});
register.registerMetric(bidsProcessedCounter);

/** Histogram: End-to-end bid processing latency in seconds */
export const bidLatencyHistogram = new client.Histogram({
  name: 'bike_auction_bid_latency_seconds',
  help: 'End-to-end latency of bid placement requests in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5],
});
register.registerMetric(bidLatencyHistogram);

/** Histogram: Redis Lua evaluation duration in seconds */
export const redisLuaLatencyHistogram = new client.Histogram({
  name: 'bike_auction_redis_lua_duration_seconds',
  help: 'Duration of atomic Redis Lua bid evaluation in seconds',
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1],
});
register.registerMetric(redisLuaLatencyHistogram);

/** Histogram: PostgreSQL write-behind persistence duration in seconds */
export const postgresPersistLatencyHistogram = new client.Histogram({
  name: 'bike_auction_postgres_persist_duration_seconds',
  help: 'Duration of PostgreSQL write-behind bid persistence in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
});
register.registerMetric(postgresPersistLatencyHistogram);

/** Counter: Total soft-close extensions triggered */
export const softCloseExtensionsCounter = new client.Counter({
  name: 'bike_auction_soft_close_extensions_total',
  help: 'Total number of auction clock soft-close extensions triggered by late bids',
});
register.registerMetric(softCloseExtensionsCounter);
