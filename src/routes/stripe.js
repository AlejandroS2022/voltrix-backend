const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

// Create a Checkout Session for deposit. We create a pending deposit record
// and return the session URL to the client. The client should redirect the
// user to the returned session.url.
router.post('/session', requireAuth, express.json(), async (req, res) => {
  try {
    const { amount_cents, currency = 'usd' } = req.body;
    if (!amount_cents || amount_cents <= 0) return res.status(400).json({ error: 'amount_cents required' });
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const db = getDb();
    const reference = uuidv4();
    // insert pending deposit
    await db.query('INSERT INTO deposits (user_id, amount_cents, reference, status, created_at) VALUES ($1,$2,$3,$4,NOW())', [userId, amount_cents, reference, 'pending']);

    const successUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/?deposit_success=1`;
    const cancelUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/?deposit_cancel=1`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: currency,
          product_data: { name: `Deposit ${currency.toUpperCase()}` },
          unit_amount: amount_cents
        },
        quantity: 1
      }],
      metadata: { user_id: String(userId), reference },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('stripe session error', err);
    res.status(500).json({ error: 'stripe_session_failed' });
  }
});

// Webhook endpoint: must be mounted before express.json() middleware so
// we can access raw body for signature verification. Configure
// STRIPE_WEBHOOK_SECRET env var and point Stripe dashboard to /api/stripe/webhook.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (!secret) {
      console.warn('STRIPE_WEBHOOK_SECRET not configured — cannot verify events');
      // fall back to parsing body (best-effort)
      event = req.body;
    } else {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    }
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const reference = metadata.reference;
    const userId = parseInt(metadata.user_id, 10);
    const amount_cents = session.amount_total || 0;

    const db = getDb();
    try {
      await db.query('BEGIN');
      // idempotency: check deposit row
      const q = await db.query('SELECT id, status FROM deposits WHERE reference=$1 FOR UPDATE', [reference]);
      if (q.rowCount === 0) {
        // no deposit found — insert one
        await db.query('INSERT INTO deposits (user_id, amount_cents, reference, status, created_at) VALUES ($1,$2,$3,$4,NOW())', [userId, amount_cents, reference, 'completed']);
      } else {
        const row = q.rows[0];
        if (row.status === 'completed') {
          await db.query('COMMIT');
          return res.json({ received: true });
        }
        await db.query('UPDATE deposits SET status=$1 WHERE reference=$2', ['completed', reference]);
      }

      // credit wallet
      await db.query('UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id=$2', [amount_cents, userId]);

      await db.query('COMMIT');
      return res.json({ received: true });
    } catch (err) {
      await db.query('ROLLBACK');
      console.error('Failed to process stripe webhook', err);
      return res.status(500).json({ error: 'webhook_processing_failed' });
    }
  }

  res.json({ received: true });
});

module.exports = router;
