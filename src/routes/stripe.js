const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notifyUser } = require('../socket');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const { writeLedger } = require('../utils/ledger');

// helper to ensure frontend urls
function buildFrontendUrl(pathQuery) {
  const raw = process.env.FRONTEND_URL || 'http://localhost:5173';
  const prefixed = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
  const base = prefixed.replace(/\/$/, '');
  return `${base}${pathQuery.startsWith('/') ? pathQuery : '/' + pathQuery}`;
}

// Create a Stripe Connect account (Express) and save the account id on the user record.
router.post('/connect/create-account', requireAuth, async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('Stripe secret key not configured');
      return res.status(500).json({ error: 'stripe_not_configured' });
    }
    const userId = req.user.userId;
    const db = getDb();
    const q = await db.query('SELECT email, stripe_account_id FROM users WHERE id=$1', [userId]);
    if (q.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
    const user = q.rows[0];
    if (user.stripe_account_id) return res.json({ ok: true, stripe_account_id: user.stripe_account_id });

    const account = await stripe.accounts.create({ type: 'express', email: user.email });
    await db.query('UPDATE users SET stripe_account_id=$1 WHERE id=$2', [account.id, userId]);
    res.json({ ok: true, stripe_account_id: account.id });
  } catch (err) {
    console.error('create connect account error', err && err.message ? err.message : err);
    // surface Stripe error message to client for debugging (safe to show message)
    return res.status(500).json({ error: 'create_connect_account_failed', message: err && err.message ? err.message : undefined });
  }
});

// Create an account link to redirect the user to Stripe onboarding (Express)
router.get('/connect/account-link', requireAuth, async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('Stripe secret key not configured');
      return res.status(500).json({ error: 'stripe_not_configured' });
    }
    const userId = req.user.userId;
    const db = getDb();
    const q = await db.query('SELECT stripe_account_id FROM users WHERE id=$1', [userId]);
    if (q.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
    const acctId = q.rows[0].stripe_account_id;
    if (!acctId) return res.status(400).json({ error: 'connect_account_required' });

    const accountLink = await stripe.accountLinks.create({
      account: acctId,
      refresh_url: buildFrontendUrl('/app/profile'),
      return_url: buildFrontendUrl('/app/profile'),
      type: 'account_onboarding'
    });
    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('create account link error', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'create_account_link_failed', message: err && err.message ? err.message : undefined });
  }
});

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

    // Ensure FRONTEND_URL includes protocol (Stripe requires absolute URLs)
    function buildFrontendUrl(pathQuery) {
      const raw = process.env.FRONTEND_URL || 'http://localhost:5173';
      const prefixed = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
      // remove trailing slash
      const base = prefixed.replace(/\/$/, '');
      return `${base}${pathQuery.startsWith('/') ? pathQuery : '/' + pathQuery}`;
    }

    const successUrl = buildFrontendUrl('/app');
    const cancelUrl = buildFrontendUrl('/app/deposit');

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

// Webhook endpoint for v1 events (checkout, transfers, etc.)
// Configure STRIPE_WEBHOOK_SECRET env var and point Stripe dashboard to /api/stripe/webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (!secret) {
      console.warn('STRIPE_WEBHOOK_SECRET not configured — cannot verify events');
      event = req.body;
    } else {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    }
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  await handleStripeEvent(event, res);
});

// Webhook endpoint for v2 events (account-related)
// Configure STRIPE_WEBHOOK_SECRET_V2 env var for v2 events
router.post('/webhook/v2', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET_V2 || process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (!secret) {
      console.warn('STRIPE_WEBHOOK_SECRET_V2 not configured — cannot verify events');
      event = req.body;
    } else {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    }
  } catch (err) {
    console.error('Webhook v2 signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  await handleStripeEvent(event, res);
});

// Unified event handler for both v1 and v2 webhooks
async function handleStripeEvent(event, res) {
  const db = getDb();
  
  try {
    // Handle checkout.session.completed
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const metadata = session.metadata || {};
      const reference = metadata.reference;
      const userId = parseInt(metadata.user_id, 10);
      const amount_cents = session.amount_total || 0;

      try {
        await db.query('BEGIN');
        const q = await db.query('SELECT id, status FROM deposits WHERE reference=$1 FOR UPDATE', [reference]);
        let depositId = null;
        if (q.rowCount === 0) {
          const ins = await db.query('INSERT INTO deposits (user_id, amount_cents, reference, status, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id', [userId, amount_cents, reference, 'completed']);
          depositId = ins.rows[0].id;
        } else {
          const row = q.rows[0];
          depositId = row.id;
          if (row.status === 'completed') {
            await db.query('COMMIT');
            return res.json({ received: true });
          }
          await db.query('UPDATE deposits SET status=$1 WHERE reference=$2', ['completed', reference]);
        }

        const wq = await db.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [userId]);
        const before = parseInt((wq.rows[0] && wq.rows[0].balance_cents) || 0, 10);
        const after = before + amount_cents;
        await db.query('UPDATE wallets SET balance_cents = $1 WHERE user_id=$2', [after, userId]);

        await writeLedger(db, {
          userId,
          related_order_id: depositId,
          change_cents: amount_cents,
          balance_before: before,
          balance_after: after,
          type: 'deposit',
          meta: { reference },
          reference,
          status: 'completed'
        });

        await db.query('COMMIT');

        try {
          notifyUser(userId, 'wallet:updated', { 
            balance_cents: after,
            type: 'deposit',
            amount_cents 
          });
        } catch (e) {
          console.warn('Failed to notify user about deposit:', e.message);
        }

        return res.json({ received: true });
      } catch (err) {
        await db.query('ROLLBACK');
        console.error('Failed to process stripe webhook', err);
        return res.status(500).json({ error: 'webhook_processing_failed' });
      }
    }

    // Handle account updates (onboarding / verification state changes) - v1 and v2
    if (event.type && (event.type.startsWith('account.') || event.type.startsWith('account_updated'))) {
      try {
        const acct = event.data.object;
        const acctId = acct.id;
        
        // Get verification status from the event
        const chargesEnabled = acct.charges_enabled || false;
        const payoutsEnabled = acct.payouts_enabled || false;
        const requirements = acct.requirements || {};
        const currentlyDue = requirements.currently_due || [];
        const isVerified = chargesEnabled && payoutsEnabled && currentlyDue.length === 0;
        
        const q = await db.query('SELECT id FROM users WHERE stripe_account_id=$1', [acctId]);
        if (q.rowCount > 0) {
          const userId = q.rows[0].id;
          
          // Update user verification status
          await db.query(
            `UPDATE users SET stripe_verified=$1, stripe_charges_enabled=$2, stripe_payouts_enabled=$3 WHERE id=$4`,
            [isVerified, chargesEnabled, payoutsEnabled, userId]
          );
          
          // Update KYC submissions with Stripe verification status
          await db.query(
            `INSERT INTO kyc_submissions (user_id, date_of_birth, phone, country, city_state, street, employer_company, employer_city, id_number, status, created_at)
             VALUES ($1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2, NOW())
             ON CONFLICT DO NOTHING`,
            [userId, isVerified ? 'approved' : 'pending']
          );
          
          // Notify frontend about verification status change
          notifyUser(userId, 'kyc:updated', { 
            verified: isVerified,
            charges_enabled: chargesEnabled,
            payouts_enabled: payoutsEnabled
          });
        }
      } catch (err) {
        console.error('account.updated webhook handling failed', err);
      }
    }

    // Handle transfer events for withdrawals
    if (event.type === 'transfer.created' || event.type === 'transfer.failed') {
      const transfer = event.data.object;
      const metadata = transfer.metadata || {};
      const withdrawalId = metadata.withdrawal_id;
      
      if (withdrawalId) {
        const status = event.type === 'transfer.created' ? 'completed' : 'failed';
        try {
          await db.query('UPDATE withdrawals SET status=$1 WHERE id=$2', [status, withdrawalId]);
          await db.query('UPDATE ledger SET status=$1 WHERE reference=$2', [status, String(withdrawalId)]);
        } catch (err) {
          console.error('Failed to update transfer status', err);
        }
      }
    }

    // Handle payout events
    if (event.type === 'payout.paid' || event.type === 'payout.failed' || event.type === 'payout.returned') {
      const payout = event.data.object;
      const metadata = payout.metadata || {};
      // Handle payout status updates if needed
      console.log('Payout event:', event.type, payout.id);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Stripe event handling error:', err);
    res.status(500).json({ error: 'event_handling_failed' });
  }
}

module.exports = router;
