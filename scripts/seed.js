require('dotenv').config();
const { initDb } = require('../src/db');
const bcrypt = require('bcrypt');

async function seed() {
  const db = await initDb();
  try {
    const pw = await bcrypt.hash('demo1234', parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10));
    const userRes = await db.query('INSERT INTO users (first_name, last_name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id', ['name1', 'name2', 'demo@demo.com', pw]);
    const userId = userRes.rows[0].id;
    await db.query('INSERT INTO wallets (user_id, balance_cents) VALUES ($1, $2)', [userId, 1000000]); // $10k
    await db.query("INSERT INTO assets (symbol, name) VALUES ('BTCUSD', 'Bitcoin / USD') ON CONFLICT DO NOTHING");
    console.log('Seeded demo user: demo@demo.com / demo1234');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed', err);
    process.exit(1);
  }
}

seed();
