const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validateOrder, validateDepositWithdraw } = require('../middleware/validate');
const { placeOrder, closePosition } = require('../services/matchingEngine');
const { v4: uuidv4 } = require('uuid');
const { cacheGet, cacheSet } = require('../utils/cache');

const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

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
    // Ensure KYC approved
    const kycQ = await db.query('SELECT status FROM kyc_submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user.userId]);
    if (kycQ.rowCount === 0 || kycQ.rows[0].status !== 'approved') {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'kyc_required' });
    }

    const wallet = await db.query(
      'SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE',
      [req.user.userId]
    );
    const balance = parseInt(wallet.rows[0].balance_cents, 10);
    if (balance < amount_cents) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    // Check Stripe Connect account for this user
    const userQ = await db.query('SELECT stripe_account_id FROM users WHERE id=$1', [req.user.userId]);
    const acctId = userQ.rowCount ? userQ.rows[0].stripe_account_id : null;
    if (!acctId) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'connect_account_required' });
    }

    // debit wallet and create withdrawal row as pending
    await db.query(
      'UPDATE wallets SET balance_cents = balance_cents - $1 WHERE user_id=$2',
      [amount_cents, req.user.userId]
    );
    const withdrawRes = await db.query(
      'INSERT INTO withdrawals (user_id, amount_cents, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id',
      [req.user.userId, amount_cents, 'pending']
    );
    const withdrawalId = withdrawRes.rows[0].id;

    // create a transfer to the connected account (platform must have Stripe balance for this)
    try {
      const transfer = await stripe.transfers.create({
        amount: amount_cents,
        currency: 'usd',
        destination: acctId,
        metadata: { withdrawal_id: String(withdrawalId), user_id: String(req.user.userId) }
      });

      // mark withdrawal completed
      await db.query('UPDATE withdrawals SET status=$1 WHERE id=$2', ['completed', withdrawalId]);
      await db.query('COMMIT');
      return res.json({ success: true, transfer_id: transfer.id });
    } catch (err) {
      // attempt to revert wallet debit
      await db.query('UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id=$2', [amount_cents, req.user.userId]);
      await db.query('UPDATE withdrawals SET status=$1 WHERE id=$2', ['failed', withdrawalId]);
      await db.query('COMMIT');
      console.error('stripe transfer failed', err);
      return res.status(500).json({ error: 'transfer_failed' });
    }
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Withdraw failed' });
  }
});

// Note: order-placement endpoints removed — system uses positions now.

// Place a new position (market or limit). This replaces the old /order endpoint.
router.post('/positions', requireAuth, validateOrder, async (req, res) => {
  try {
    const { side, order_type, price_cents, size, stop_loss_cents, take_profit_cents, symbol } = req.body;
    if (!side || !size) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await placeOrder({ userId: req.user.userId, side, order_type, price_cents, size, stop_loss_cents, take_profit_cents, symbol });
    if (result && result.ok) return res.json(result);
    return res.status(400).json({ error: result.error || 'position_placement_failed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Position placement failed' });
  }
});

// List open positions for the current user
router.get('/positions', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const q = await db.query(
       `SELECT id, symbol, side, size, entry_price_cents, placed_price_cents, order_type, stop_loss_cents, take_profit_cents, status, realized_pnl_cents, created_at, closed_at, close_price_cents
         FROM positions WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json(q.rows);
  } catch (err) {
    console.error('positions list error', err);
    res.status(500).json({ error: 'positions_list_failed' });
  }
});

// Close a position (manual market close)
router.post('/positions/:id/close', requireAuth, async (req, res) => {
  const positionId = req.params.id;
  try {
    const result = await closePosition({ positionId: positionId });
    if (result && result.ok) return res.json(result);
    return res.status(400).json({ error: result.error || 'close_failed' });
  } catch (err) {
    console.error('position close error', err);
    res.status(500).json({ error: 'position_close_failed' });
  }
});

// Orders removed — system operates on positions. Legacy cancellation removed.

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

// KYC submission (insert a new kyc_submissions row). Accepts the expanded KYC fields.
router.post('/kyc/submit', requireAuth, async (req, res) => {
  try {
    const {
      date_of_birth, phone,
      country, city_state, street,
      employer_company, employer_city,
      id_number
    } = req.body;
    // id_number is optional during incremental KYC submissions
      const db = getDb();
      // If the user already has a KYC row, update it instead of inserting a new one.
      const existing = await db.query('SELECT id FROM kyc_submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user.userId]);
      let kycRow;
      if (existing.rowCount > 0) {
        const id = existing.rows[0].id;
        const upd = await db.query(
          `UPDATE kyc_submissions SET date_of_birth=$1, phone=$2, country=$3, city_state=$4, street=$5, employer_company=$6, employer_city=$7, id_number=$8, status=$9 WHERE id=$10 RETURNING *`,
          [date_of_birth || null, phone || null, country || null, city_state || null, street || null, employer_company || null, employer_city || null, id_number, 'pending', id]
        );
        kycRow = upd.rows[0];
      } else {
        const insertQ = await db.query(
          `INSERT INTO kyc_submissions (user_id, date_of_birth, phone, country, city_state, street, employer_company, employer_city, id_number, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *`,
          [req.user.userId, date_of_birth || null, phone || null, country || null, city_state || null, street || null, employer_company || null, employer_city || null, id_number, 'pending']
        );
        kycRow = insertQ.rows[0];
      }
      res.json({ ok: true, kyc: kycRow });
  } catch (err) {
    console.error('kyc submit error', err);
    res.status(500).json({ error: 'kyc_submit_failed' });
  }
});

router.get('/kyc/status', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const q = await db.query('SELECT * FROM kyc_submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user.userId]);
    if (q.rowCount === 0) return res.json({ status: 'not_submitted' });
    res.json(q.rows[0]);
  } catch (err) {
    console.error('kyc status error', err);
    res.status(500).json({ error: 'kyc_status_failed' });
  }
});

module.exports = router;
