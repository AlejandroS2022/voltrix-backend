const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { invalidateFeeCache } = require('../services/priceStream');

async function requireAdmin(req, res, next) {
  try {
    const db = getDb();
    const q = await db.query('SELECT is_admin FROM users WHERE id=$1', [req.user.userId]);
    if (q.rowCount === 0) return res.status(403).json({ error: 'forbidden' });
    if (!q.rows[0].is_admin) return res.status(403).json({ error: 'admin_required' });
    return next();
  } catch (err) {
    console.error('requireAdmin error', err);
    return res.status(500).json({ error: 'admin_check_failed' });
  }
}

// Fees management
router.get('/fees', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const q = await db.query('SELECT id, symbol, fee_type, fee_value FROM symbol_fees ORDER BY symbol');
    res.json(q.rows);
  } catch (err) {
    console.error('fetch fees error', err);
    res.status(500).json({ error: 'fetch_fees_failed' });
  }
});

// upsert fee for a symbol
router.post('/fees', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { symbol, fee_type, fee_value } = req.body;
    if (!symbol || !fee_type || typeof fee_value === 'undefined') return res.status(400).json({ error: 'invalid_payload' });
    const db = getDb();
    const q = await db.query('SELECT id FROM symbol_fees WHERE symbol=$1 LIMIT 1', [symbol.toUpperCase()]);
    if (q.rowCount === 0) {
      await db.query('INSERT INTO symbol_fees (symbol, fee_type, fee_value, created_at, updated_at) VALUES ($1,$2,$3,NOW(),NOW())', [symbol.toUpperCase(), fee_type, fee_value]);
    } else {
      await db.query('UPDATE symbol_fees SET fee_type=$1, fee_value=$2, updated_at=NOW() WHERE symbol=$3', [fee_type, fee_value, symbol.toUpperCase()]);
    }
    // invalidate in-memory fee cache so next tick picks up the change
    try { invalidateFeeCache(symbol); } catch (e) { console.warn('invalidate fee cache failed', e); }
    res.json({ ok: true });
  } catch (err) {
    console.error('upsert fee error', err);
    res.status(500).json({ error: 'upsert_fee_failed' });
  }
});

// KYC admin endpoints: list submissions and approve/reject
router.get('/kyc', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const q = await db.query(
      `SELECT * FROM kyc_submissions ORDER BY created_at DESC LIMIT 200`
    );
    res.json(q.rows);
  } catch (err) {
    console.error('fetch kyc error', err);
    res.status(500).json({ error: 'fetch_kyc_failed' });
  }
});

router.post('/kyc/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = getDb();
    await db.query('UPDATE kyc_submissions SET status=$1 WHERE id=$2', ['approved', id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('approve kyc error', err);
    res.status(500).json({ error: 'approve_failed' });
  }
});

router.post('/kyc/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = getDb();
    await db.query('UPDATE kyc_submissions SET status=$1 WHERE id=$2', ['rejected', id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('reject kyc error', err);
    res.status(500).json({ error: 'reject_failed' });
  }
});

module.exports = router;
