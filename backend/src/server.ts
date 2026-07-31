import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { getRedisClient, getRedisSubscriber, closeRedisConnections } from './config/redis';
import { getPool, closePool } from './config/database';
import { logger } from './config/logger';
import { BiddingEngine } from './services/bidding-engine';
import { AuctionSocketServer } from './websocket/auction-socket';
import { Client } from 'pg'; // <-- ADDED THIS IMPORT

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

  // --- ADDED TEMPORARY DB INIT ROUTE HERE ---
 app.get('/init-db', async (req, res) => {
      // Bypassing firewalls by using Render's Internal Network
      const client = new Client({
          connectionString: "postgresql://faizal:CeTBtmLZ53zc8WAjiWVBUxvneuddYYsG@dpg-d9m3g4oae00c73bc2hr0-a/bike_auction_e4e7"
      });

      try {
          await client.connect();
          const response = await fetch("https://raw.githubusercontent.com/Faizzyyy13/bike-auction-platform/main/database/schema.sql");
          const sql = await response.text();
          await client.query(sql);
          res.send("✅ SUCCESS! Database tables created from GitHub.");
      } catch (error: any) {
          res.status(500).send(`❌ Failed: ${error.message}`);
      } finally {
          await client.end();
      }
  });
  // ------------------------------------------

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
