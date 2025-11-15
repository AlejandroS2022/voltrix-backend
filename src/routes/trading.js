const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validateOrder, validateDepositWithdraw } = require('../middleware/validate');
const { placeOrder } = require('../services/matchingEngine');
const { v4: uuidv4 } = require('uuid');
const { cacheGet, cacheSet } = require('../utils/cache');

const router = express.Router();

router.get('/wallet', requireAuth, async (req, res) => {
  const db = getDb();
  const q = await db.query(
    'SELECT balance_cents FROM wallets WHERE user_id=$1',
    [req.user.userId]
  );
  const row = q.rows[0] || { balance_cents: 0 };
  res.json({ balance_cents: parseInt(row.balance_cents, 10) });
});

router.post('/deposit', requireAuth, validateDepositWithdraw, async (req, res) => {
  const db = getDb();
  await db.query('BEGIN');
  try {
    const { amount_cents, reference } = req.body;
    if (!amount_cents || amount_cents <= 0) return res.status(400).json({ error: 'Amount is required' });

    await db.query(
      'UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id=$2',
      [amount_cents, req.user.userId]
    );
    await db.query(
      'INSERT INTO deposits (user_id, amount_cents, reference, created_at) VALUES ($1, $2, $3, NOW())',
      [req.user.userId, amount_cents, reference || uuidv4()]
    );
    await db.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

router.post('/withdraw', requireAuth, validateDepositWithdraw, async (req, res) => {
  const db = getDb();
  await db.query('BEGIN');
  try {
    const { amount_cents } = req.body;
    if (!amount_cents || amount_cents <= 0) return res.status(400).json({ error: 'Amount is required' });

    const wallet = await db.query(
      'SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE',
      [req.user.userId]
    );
    const balance = parseInt(wallet.rows[0].balance_cents, 10);
    if (balance < amount_cents) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    await db.query(
      'UPDATE wallets SET balance_cents = balance_cents - $1 WHERE user_id=$2',
      [amount_cents, req.user.userId]
    );
    await db.query(
      'INSERT INTO withdrawals (user_id, amount_cents, status, created_at) VALUES ($1, $2, $3, NOW())',
      [req.user.userId, amount_cents, 'completed']
    );
    await db.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Withdraw failed' });
  }
});

router.post('/order', requireAuth, validateOrder, async (req, res) => {
  try {
    const { side, price_cents, size } = req.body;
    if (!side || !price_cents || !size) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await placeOrder(req.user.userId, side, price_cents, size);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Order failed' });
  }
});

router.get('/open-orders', requireAuth, async (req, res) => {
  const db = getDb();
  const q = await db.query(
    `SELECT * FROM orders WHERE user_id=$1 AND status='open' ORDER BY created_at DESC`,
    [req.user.userId]
  );
  res.json(q.rows);
});

router.get('/trades', requireAuth, async (req, res) => {
  const cacheKey = 'recent_trades';
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const db = getDb();
  const q = await db.query(
    `SELECT * FROM trades ORDER BY executed_at DESC LIMIT 50`
  );

  await cacheSet(cacheKey, q.rows, 5);
  res.json(q.rows);
});

module.exports = router;
