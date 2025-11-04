require('dotenv').config();
const { initDb, getDb } = require('../src/db');

async function migrate() {
  const pool = await initDb();
  const client = pool;
  const sql = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(320) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance_cents BIGINT DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount_cents BIGINT NOT NULL,
    reference TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount_cents BIGINT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(32) UNIQUE NOT NULL,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    side VARCHAR(10) NOT NULL,
    price_cents BIGINT NOT NULL,
    size NUMERIC NOT NULL,
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    buy_order_id INTEGER REFERENCES orders(id),
    sell_order_id INTEGER REFERENCES orders(id),
    price_cents BIGINT NOT NULL,
    size NUMERIC NOT NULL,
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT now()
  );
  `;
  try {
    await client.query(sql);
    console.log('Migration finished');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed', err);
    process.exit(1);
  }
}

migrate();
