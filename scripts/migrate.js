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
    status VARCHAR(32) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
  );

  -- ensure deposits has status column for older schemas
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='deposits' AND column_name='status') THEN
      ALTER TABLE deposits ADD COLUMN status VARCHAR(32) DEFAULT 'pending';
    END IF;
  END$$;

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
    price_cents BIGINT,
    size NUMERIC NOT NULL,
    symbol VARCHAR(32) DEFAULT 'BTCUSD',
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS positions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(32) NOT NULL,
    side VARCHAR(10) NOT NULL,
    size NUMERIC NOT NULL,
    entry_price_cents BIGINT NOT NULL,
    stop_loss_cents BIGINT,
    take_profit_cents BIGINT,
    order_type VARCHAR(20) DEFAULT 'market',
    status VARCHAR(20) DEFAULT 'open',
    realized_pnl_cents BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    closed_at TIMESTAMP WITH TIME ZONE,
    close_price_cents BIGINT
  );

  -- Add order-type fields and risk levels (stop loss / take profit) if missing
  ALTER TABLE orders ALTER COLUMN price_cents DROP NOT NULL;
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='order_type') THEN
      ALTER TABLE orders ADD COLUMN order_type VARCHAR(20) DEFAULT 'limit';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='stop_loss_cents') THEN
      ALTER TABLE orders ADD COLUMN stop_loss_cents BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='take_profit_cents') THEN
      ALTER TABLE orders ADD COLUMN take_profit_cents BIGINT;
    END IF;
  END$$;

  -- ensure positions have order_type, stop_loss, take_profit columns
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='positions' AND column_name='order_type') THEN
      ALTER TABLE positions ADD COLUMN order_type VARCHAR(20) DEFAULT 'market';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='positions' AND column_name='stop_loss_cents') THEN
      ALTER TABLE positions ADD COLUMN stop_loss_cents BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='positions' AND column_name='take_profit_cents') THEN
      ALTER TABLE positions ADD COLUMN take_profit_cents BIGINT;
    END IF;
    -- ensure we store the market price at placement time
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='positions' AND column_name='placed_price_cents') THEN
      ALTER TABLE positions ADD COLUMN placed_price_cents BIGINT;
    END IF;
    -- remove broker_order_id and index if present (we no longer place orders on broker)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='positions' AND column_name='broker_order_id') THEN
      ALTER TABLE positions DROP COLUMN broker_order_id;
    END IF;
  END$$;
  -- drop index if exists (cleanup)
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='idx_positions_broker_order_id') THEN
      EXECUTE 'DROP INDEX idx_positions_broker_order_id';
    END IF;
  END$$;

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

  -- KYC submissions table
  CREATE TABLE IF NOT EXISTS kyc_submissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    date_of_birth DATE,
    phone TEXT,
    country TEXT,
    city_state TEXT,
    street TEXT,
    employer_company TEXT,
    employer_city TEXT,
    id_number TEXT,
    status VARCHAR(32) DEFAULT 'pending', -- pending/approved/rejected
    created_at TIMESTAMPTZ DEFAULT now()
  );

  -- ensure additional KYC columns exist for older schemas
  DO $$
  BEGIN
    -- first_name and last_name are intentionally omitted; use users table instead
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_submissions' AND column_name='date_of_birth') THEN
      ALTER TABLE kyc_submissions ADD COLUMN date_of_birth DATE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_submissions' AND column_name='phone') THEN
      ALTER TABLE kyc_submissions ADD COLUMN phone TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_submissions' AND column_name='country') THEN
      ALTER TABLE kyc_submissions ADD COLUMN country TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_submissions' AND column_name='city_state') THEN
      ALTER TABLE kyc_submissions ADD COLUMN city_state TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_submissions' AND column_name='street') THEN
      ALTER TABLE kyc_submissions ADD COLUMN street TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_submissions' AND column_name='employer_company') THEN
      ALTER TABLE kyc_submissions ADD COLUMN employer_company TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_submissions' AND column_name='employer_city') THEN
      ALTER TABLE kyc_submissions ADD COLUMN employer_city TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_submissions' AND column_name='id_number') THEN
      ALTER TABLE kyc_submissions ADD COLUMN id_number TEXT;
    END IF;
    -- document_url field removed; not stored here
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_submissions' AND column_name='status') THEN
      ALTER TABLE kyc_submissions ADD COLUMN status VARCHAR(32) DEFAULT 'pending';
    END IF;
  END$$;

  -- Symbol-specific fee table
  CREATE TABLE IF NOT EXISTS symbol_fees (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(32) UNIQUE NOT NULL,
    fee_type VARCHAR(16) NOT NULL DEFAULT 'percent', -- percent | fixed
    fee_value NUMERIC NOT NULL DEFAULT 0, -- percent (e.g., 0.1) or fixed cents if fee_type='fixed'
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );

  -- allow marking users as admins
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_admin') THEN
      ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE;
    END IF;
  END$$;
  -- store Stripe Connect account id for payouts
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='stripe_account_id') THEN
      ALTER TABLE users ADD COLUMN stripe_account_id TEXT;
    END IF;
  END$$;
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
