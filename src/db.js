const { Pool } = require('pg');

let pool;

async function initDb() {
  if (pool) return pool;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('SELECT 1'); // test
  console.log('DB connected');
  return pool;
}

function getDb() {
  if (!pool) throw new Error('DB not initialized');
  return pool;
}

module.exports = { initDb, getDb };
