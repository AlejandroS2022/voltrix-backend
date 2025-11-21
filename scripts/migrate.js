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
    symbol VARCHAR(32) DEFAULT 'BTCUSD',
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    buy_order_id INTEGER REFERENCES orders(id),
    sell_order_id INTEGER REFERENCES orders(id),
    price_cents BIGINT NOT NULL,
    size NUMERIC NOT NULL,
    symbol VARCHAR(32) DEFAULT 'BTCUSD',
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    related_order_id INTEGER,
    change_cents BIGINT NOT NULL,
    balance_before BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    type VARCHAR(50) NOT NULL, -- deposit, withdraw, reserve, release, trade_in, trade_out, fee
    meta JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS holds (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    amount_cents BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
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
