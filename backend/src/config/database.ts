import { Pool, PoolClient } from 'pg';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// PostgreSQL Connection Pool
// ---------------------------------------------------------------------------
let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432', 10),
      database: process.env.PG_DATABASE || 'bike_auction',
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD || 'postgres',
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected PostgreSQL pool error');
    });

    _pool.on('connect', () => {
      logger.debug('PostgreSQL pool: new client connected');
    });
  }
  return _pool;
}

/**
 * Execute a callback within a database transaction.
 * Automatically commits on success and rolls back on error.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Automatically apply database/schema.sql if tables do not exist yet.
 */
export async function autoInitializeSchema(): Promise<void> {
  const pool = getPool();
  try {
    const res = await pool.query("SELECT to_regclass('public.users') as tbl");
    if (!res.rows[0].tbl) {
      logger.info('Database tables missing — automatically running schema.sql...');
      const schemaPath = path.resolve(__dirname, '../../database/schema.sql');
      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, 'utf-8');
        await pool.query(sql);
        logger.info('✅ Database schema.sql successfully applied to PostgreSQL!');
      }
    } else {
      logger.info('Database schema verified — tables already exist.');
    }
  } catch (err) {
    logger.error({ err }, 'Auto schema initialization check failed');
  }
}
