import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

async function seed() {
  const connectionString = process.argv[2];

  if (!connectionString) {
    console.error('Error: Please provide external PostgreSQL connection string.');
    process.exit(1);
  }

  console.log('Connecting to Render PostgreSQL...');
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Render PostgreSQL requires SSL for external connections
  });

  try {
    await client.connect();
    console.log('Connected successfully!');

    const schemaPath = path.resolve(__dirname, '../../../database/schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');

    console.log('Executing database schema.sql...');
    await client.query(sql);
    console.log('✅ Database schema applied successfully! All tables created.');
  } catch (err) {
    console.error('❌ Error executing schema:', err);
  } finally {
    await client.end();
  }
}

seed();
