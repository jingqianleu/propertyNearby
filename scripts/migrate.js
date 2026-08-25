import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../server/db.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const schema = await readFile(resolve(currentDirectory, '../db/schema.sql'), 'utf8');

try {
  await pool.query(schema);
  console.log('Database schema is ready.');
} finally {
  await pool.end();
}

