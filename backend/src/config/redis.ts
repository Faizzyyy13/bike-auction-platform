import Redis from 'ioredis';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Redis Client Factory
// ---------------------------------------------------------------------------
export function createRedisClient(name: string = 'default'): Redis {
  const client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5000);
      logger.warn({ attempt: times, delay, client: name }, 'Redis reconnecting');
      return delay;
    },
    lazyConnect: false,
  });

  client.on('connect', () => logger.info({ client: name }, 'Redis connected'));
  client.on('error', (err) => logger.error({ err, client: name }, 'Redis error'));

  return client;
}

// Singleton clients — one for commands, one for Pub/Sub subscriptions
let _commandClient: Redis | null = null;
let _subscriberClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_commandClient) {
    _commandClient = createRedisClient('command');
  }
  return _commandClient;
}

export function getRedisSubscriber(): Redis {
  if (!_subscriberClient) {
    _subscriberClient = createRedisClient('subscriber');
  }
  return _subscriberClient;
}

export async function closeRedisConnections(): Promise<void> {
  if (_commandClient) { await _commandClient.quit(); _commandClient = null; }
  if (_subscriberClient) { await _subscriberClient.quit(); _subscriberClient = null; }
}
