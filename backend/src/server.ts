import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { getRedisClient, getRedisSubscriber, closeRedisConnections } from './config/redis';
import { getPool, closePool } from './config/database';
import { logger } from './config/logger';
import { BiddingEngine } from './services/bidding-engine';
import { AuctionSocketServer } from './websocket/auction-socket';

// Routes
import authRoutes from './routes/auth';
import motorcycleRoutes from './routes/motorcycles';
import auctionRoutes from './routes/auctions';
import userRoutes from './routes/users';
import metricsRoutes from './routes/metrics';

// ---------------------------------------------------------------------------
// Application Bootstrap
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const PORT = parseInt(process.env.PORT || '3000', 10);

  const app = express();
  app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*', credentials: true }));
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Prometheus Metrics endpoint
  app.use('/metrics', metricsRoutes);

  // API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/motorcycles', motorcycleRoutes);
  app.use('/api/auctions', auctionRoutes);
  app.use('/api/users', userRoutes);

  const httpServer = createServer(app);

  const redisClient = getRedisClient();
  const pool = getPool();
  const biddingEngine = new BiddingEngine(redisClient, pool);
  await biddingEngine.initialize();

  const redisSubscriber = getRedisSubscriber();
  const _socketServer = new AuctionSocketServer(httpServer, biddingEngine, redisSubscriber);

  httpServer.listen(PORT, () => {
    logger.info({ port: PORT }, '🏍️  Bike Auction Engine running with Prometheus /metrics exposed');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    httpServer.close();
    await closeRedisConnections();
    await closePool();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
