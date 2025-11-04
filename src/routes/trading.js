const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { placeOrder } = require('../services/matchingEngine');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// get wallet balance
router.get('/wallet', requireAuth, async (req, res) => {
  const db = getDb();
  const q = await db.query('SELECT balance_cents FROM wallets WHERE user_id=$1', [req.user.userId]);
  const row = q.rows[0] || { balance_cents: 0 };
  res.json({ balance_cents: parseInt(row.balance_cents, 10) });
});

// deposit (sandbox)
router.post('/deposit', requireAuth, async (req, res) => {
  const { amount_cents, reference } = req.body;
  if (!amount_cents || amount_cents <= 0) return res.status(400).json({ error: 'amount required' });

  const db = getDb();
  await db.query('BEGIN');
  try {
    await db.query('UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id=$2', [amount_cents, req.user.userId]);
    await db.query(
      'INSERT INTO deposits (user_id, amount_cents, reference, created_at) VALUES ($1, $2, $3, NOW())',
      [req.user.userId, amount_cents, reference || uuidv4()]
    );
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'deposit failed' });
  }
});

// withdraw (sandbox)
router.post('/withdraw', requireAuth, async (req, res) => {
  const { amount_cents } = req.body;
  if (!amount_cents || amount_cents <= 0) return res.status(400).json({ error: 'amount required' });

  const db = getDb();
  await db.query('BEGIN');
  try {
    const q = await db.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [req.user.userId]);
    const bal = parseInt(q.rows[0].balance_cents, 10);
    if (bal < amount_cents) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'insufficient funds' });
    }
    await db.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE user_id=$2', [amount_cents, req.user.userId]);
    await db.query(
      'INSERT INTO withdrawals (user_id, amount_cents, status, created_at) VALUES ($1, $2, $3, NOW())',
      [req.user.userId, amount_cents, 'completed']
    );
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'withdraw failed' });
  }
});

router.post('/order', requireAuth, async (req, res) => {
  const { side, price_cents, size } = req.body;
  if (!side || !price_cents || !size)
    return res.status(400).json({ error: 'invalid params' });

  try {
    const result = await placeOrder(req.user.userId, side, price_cents, size);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'order failed' });
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
  const db = getDb();
  const q = await db.query(
    `SELECT * FROM trades ORDER BY executed_at DESC LIMIT 50`
  );
  res.json(q.rows);
});

module.exports = router;
