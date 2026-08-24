import pg from 'pg';

const { Pool } = pg;

function sslConfiguration() {
  const mode = String(process.env.DB_SSL || '').toLowerCase();
  if (!mode || mode === 'false' || mode === 'disable') return false;
  return { rejectUnauthorized: mode !== 'no-verify' };
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfiguration(),
  max: Number(process.env.DB_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
});

pool.on('error', error => {
  console.error('Unexpected PostgreSQL connection error:', error);
});

export function query(text, values) {
  return pool.query(text, values);
}

export async function withTransaction(operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

