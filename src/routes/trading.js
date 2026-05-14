const express = require("express");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const {
  validateOrder,
  validateDepositWithdraw,
} = require("../middleware/validate");
const { placeOrder, closePosition } = require("../services/matchingEngine");
const { v4: uuidv4 } = require("uuid");
const { cacheGet, cacheSet } = require("../utils/cache");

const router = express.Router();
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
const { writeLedger } = require("../utils/ledger");
const { notifyAdmin, notifyUser } = require("../socket");

router.get("/wallet", requireAuth, async (req, res) => {
  const db = getDb();
  const q = await db.query(
    "SELECT balance_cents FROM wallets WHERE user_id=$1",
    [req.user.userId],
  );
  const row = q.rows[0] || { balance_cents: 0 };
  res.json({ balance_cents: parseInt(row.balance_cents, 10) });
});

router.post(
  "/deposit",
  requireAuth,
  validateDepositWithdraw,
  async (req, res) => {
    const db = getDb();
    await db.query("BEGIN");
    try {
      const { amount_cents, reference } = req.body;
      if (!amount_cents || amount_cents <= 0)
        return res.status(400).json({ error: "Amount is required" });
      // lock wallet and compute before/after balances
      const wq = await db.query(
        "SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE",
        [req.user.userId],
      );
      const before = parseInt(
        (wq.rows[0] && wq.rows[0].balance_cents) || 0,
        10,
      );
      const after = before + amount_cents;

      await db.query("UPDATE wallets SET balance_cents = $1 WHERE user_id=$2", [
        after,
        req.user.userId,
      ]);

      const ref = reference || uuidv4();
      await db.query(
        "INSERT INTO deposits (user_id, amount_cents, reference, created_at, status) VALUES ($1, $2, $3, NOW(), $4)",
        [req.user.userId, amount_cents, ref, "completed"],
      );

      // ledger entry for deposit
      await writeLedger(db, {
        userId: req.user.userId,
        related_order_id: null,
        change_cents: amount_cents,
        balance_before: before,
        balance_after: after,
        type: "deposit",
        meta: { reference: ref },
        reference: ref,
        status: "completed",
      });

      await db.query("COMMIT");
      syncBalance(req.user.userId, after);
      res.json({ success: true, reference: ref });
    } catch (err) {
      await db.query("ROLLBACK");
      console.error(err);
      res.status(500).json({ error: "Deposit failed" });
    }
  },
);

// Helper to build frontend URL
function buildFrontendUrl(pathQuery) {
  const raw = process.env.FRONTEND_URL || "http://localhost:5173";
  const prefixed =
    raw.startsWith("http://") || raw.startsWith("https://")
      ? raw
      : `http://${raw}`;
  const base = prefixed.replace(/\/$/, "");
  return `${base}${pathQuery.startsWith("/") ? pathQuery : "/" + pathQuery}`;
}

router.post(
  "/withdraw",
  requireAuth,
  validateDepositWithdraw,
  async (req, res) => {
    const db = getDb();
    await db.query("BEGIN");
    try {
      const { amount_cents } = req.body;
      if (!amount_cents || amount_cents <= 0)
        return res.status(400).json({ error: "Amount is required" });

      // Check KYC status - must be approved for withdrawals
      const kycQ = await db.query(
        "SELECT status FROM kyc_submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
        [req.user.userId],
      );
      if (kycQ.rowCount === 0 || kycQ.rows[0].status !== "approved") {
        await db.query("ROLLBACK");
        return res.status(403).json({ error: "kyc_required" });
      }

      // Check if user has Stripe Connect account - if not, create one and return onboarding link
      const userQ = await db.query(
        "SELECT stripe_account_id FROM users WHERE id=$1",
        [req.user.userId],
      );
      let stripeAccountId = userQ.rows[0]?.stripe_account_id;

      if (!stripeAccountId) {
        // Create Stripe Connect Express account
        const userEmailQ = await db.query(
          "SELECT email FROM users WHERE id=$1",
          [req.user.userId],
        );
        const email = userEmailQ.rows[0]?.email;

        const account = await stripe.accounts.create({
          type: "express",
          email: email,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
        });

        stripeAccountId = account.id;
        await db.query("UPDATE users SET stripe_account_id=$1 WHERE id=$2", [
          stripeAccountId,
          req.user.userId,
        ]);

        // Create account link for onboarding
        const accountLink = await stripe.accountLinks.create({
          account: stripeAccountId,
          refresh_url: buildFrontendUrl("/app/withdraw"),
          return_url: buildFrontendUrl("/app/withdraw"),
          type: "account_onboarding",
        });

        await db.query("COMMIT");

        return res.json({
          requires_onboarding: true,
          onboarding_url: accountLink.url,
        });
      }

      // Check if Stripe account is fully set up (has charges enabled)
      try {
        const account = await stripe.accounts.retrieve(stripeAccountId);
        if (!account.charges_enabled || !account.payouts_enabled) {
          // Account needs more info - create new onboarding link
          const accountLink = await stripe.accountLinks.create({
            account: stripeAccountId,
            refresh_url: buildFrontendUrl("/app/withdraw"),
            return_url: buildFrontendUrl("/app/withdraw"),
            type: "account_onboarding",
          });

          await db.query("COMMIT");

          return res.json({
            requires_onboarding: true,
            onboarding_url: accountLink.url,
          });
        }
      } catch (acctErr) {
        console.error("Error retrieving Stripe account:", acctErr);
      }

      // debit wallet and create withdrawal row as pending
      const walletBeforeQ = await db.query(
        "SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE",
        [req.user.userId],
      );
      const walletBefore = parseInt(
        (walletBeforeQ.rows[0] && walletBeforeQ.rows[0].balance_cents) || 0,
        10,
      );

      if (walletBefore < amount_cents) {
        await db.query("ROLLBACK");
        return res.status(400).json({ error: "Insufficient funds" });
      }

      const walletAfter = walletBefore - amount_cents;

      await db.query("UPDATE wallets SET balance_cents = $1 WHERE user_id=$2", [
        walletAfter,
        req.user.userId,
      ]);
      const withdrawRes = await db.query(
        "INSERT INTO withdrawals (user_id, amount_cents, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id",
        [req.user.userId, amount_cents, "pending"],
      );
      const withdrawalId = withdrawRes.rows[0].id;

      // ledger entry for pending withdrawal (negative change)
      const ledgerId = await writeLedger(db, {
        userId: req.user.userId,
        related_order_id: null,
        change_cents: -amount_cents,
        balance_before: walletBefore,
        balance_after: walletAfter,
        type: "withdrawal",
        meta: { withdrawal_id: withdrawalId },
        reference: String(withdrawalId),
        status: "pending",
      });

      // 1) Commit the pending deduction first
      await db.query("COMMIT");
      syncBalance(req.user.userId, walletAfter);

      // 2) Now safely execute Stripe processing outside the transaction
      try {
        const transfer = await stripe.transfers.create({
          amount: amount_cents,
          currency: "usd",
          destination: stripeAccountId,
          metadata: {
            withdrawal_id: String(withdrawalId),
            user_id: String(req.user.userId),
          },
        });

        await db.query(
          "UPDATE withdrawals SET status=$1, stripe_transfer_id=$2 WHERE id=$3",
          ["completed", transfer.id, withdrawalId],
        );
        await db.query(
          "UPDATE ledger SET status=$1, updated_at=NOW() WHERE id=$2",
          ["completed", ledgerId],
        );
      } catch (transferErr) {
        // If transfer fails right away, refund the user so they can try again.
        console.error("Transfer creation failed:", transferErr);
        await db.query("BEGIN");
        const refundWalletQ = await db.query(
          "SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE",
          [req.user.userId],
        );
        const rfBefore = parseInt(
          (refundWalletQ.rows[0] && refundWalletQ.rows[0].balance_cents) || 0,
          10,
        );
        const rfAfter = rfBefore + amount_cents;
        await db.query(
          "UPDATE wallets SET balance_cents = $1 WHERE user_id=$2",
          [rfAfter, req.user.userId],
        );

        await writeLedger(db, {
          userId: req.user.userId,
          related_order_id: null,
          change_cents: amount_cents,
          balance_before: rfBefore,
          balance_after: rfAfter,
          type: "refund",
          meta: {
            refund_for_withdrawal_id: withdrawalId,
            reason: "transfer_failed",
          },
          reference: `ref_${withdrawalId}`,
          status: "completed",
        });

        await db.query("UPDATE withdrawals SET status=$1 WHERE id=$2", [
          "failed",
          withdrawalId,
        ]);
        await db.query(
          "UPDATE ledger SET status=$1, updated_at=NOW() WHERE id=$2",
          ["failed", ledgerId],
        );
        await db.query("COMMIT");
        syncBalance(req.user.userId, rfAfter);

        return res
          .status(500)
          .json({ error: "Transfer failed with connected account" });
      }

      return res.json({ success: true });
    } catch (err) {
      // try rollback if transaction was active
      try {
        await db.query("ROLLBACK");
      } catch (e) {}
      console.error(err);
      res.status(500).json({ error: "Withdraw failed" });
    }
  },
);

// Note: order-placement endpoints removed — system uses positions now.

// Place a new position (market or limit). This replaces the old /order endpoint.
router.post("/positions", requireAuth, validateOrder, async (req, res) => {
  try {
    const {
      side,
      order_type,
      price_cents,
      size,
      stop_loss_cents,
      take_profit_cents,
      symbol,
    } = req.body;
    if (!side || !size) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const result = await placeOrder({
      userId: req.user.userId,
      side,
      order_type,
      price_cents,
      size,
      stop_loss_cents,
      take_profit_cents,
      symbol,
    });
    if (result && result.ok) return res.json(result);
    return res
      .status(400)
      .json({ error: result.error || "position_placement_failed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Position placement failed" });
  }
});

// List open positions for the current user
router.get("/positions", requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const q = await db.query(
      `SELECT id, symbol, side, size, entry_price_cents, placed_price_cents, order_type, stop_loss_cents, take_profit_cents, status, realized_pnl_cents, created_at, closed_at, close_price_cents
         FROM positions WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.user.userId],
    );
    res.json(q.rows);
  } catch (err) {
    console.error("positions list error", err);
    res.status(500).json({ error: "positions_list_failed" });
  }
});

// Close a position (manual market close)
router.post("/positions/:id/close", requireAuth, async (req, res) => {
  const positionId = req.params.id;
  try {
    const result = await closePosition({ positionId: positionId });
    if (result && result.ok) return res.json(result);
    return res.status(400).json({ error: result.error || "close_failed" });
  } catch (err) {
    console.error("position close error", err);
    res.status(500).json({ error: "position_close_failed" });
  }
});

// Orders removed — system operates on positions. Legacy cancellation removed.

router.get("/trades", requireAuth, async (req, res) => {
  const cacheKey = "recent_trades";
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const db = getDb();
  const q = await db.query(
    `SELECT * FROM trades ORDER BY executed_at DESC LIMIT 50`,
  );

  await cacheSet(cacheKey, q.rows, 5);
  res.json(q.rows);
});

// Unified transactions endpoint: use ledger as the canonical history table
router.get("/transactions", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.page_size || "50", 10), 1),
      200,
    );
    const offset = (page - 1) * pageSize;

    const filters = [req.user.userId];
    let where = "WHERE l.user_id=$1";
    let idx = 2;
    if (req.query.type) {
      where += ` AND l.type = $${idx}`;
      filters.push(req.query.type);
      idx++;
    }
    if (req.query.status) {
      where += ` AND l.status = $${idx}`;
      filters.push(req.query.status);
      idx++;
    }
    if (req.query.start_date) {
      where += ` AND l.created_at >= $${idx}`;
      filters.push(req.query.start_date);
      idx++;
    }
    if (req.query.end_date) {
      where += ` AND l.created_at <= $${idx}`;
      filters.push(req.query.end_date);
      idx++;
    }

    const totalRes = await db.query(
      `SELECT COUNT(1) AS total FROM ledger l ${where}`,
      filters,
    );
    const total = parseInt(totalRes.rows[0].total, 10) || 0;

    const q = await db.query(
      `SELECT l.id, l.reference AS ref, l.created_at, l.type AS display_type, l.change_cents AS amount_cents, l.status, l.meta,
              p.side AS pos_side, p.order_type as pos_order_type, p.size AS pos_size, p.entry_price_cents AS pos_margin, p.placed_price_cents AS pos_placed_price, p.stop_loss_cents AS pos_sl, p.take_profit_cents AS pos_tp, p.close_price_cents AS pos_close_price, p.symbol AS pos_symbol
        FROM ledger l
        LEFT JOIN positions p ON l.type = 'position_close' AND p.id = (l.meta->>'position_id')::integer
        ${where} ORDER BY l.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...filters, pageSize, offset],
    );

    res.json({
      page,
      page_size: pageSize,
      total,
      data: q.rows.map((r) => ({
        id: r.id,
        ref: r.ref || String(r.id),
        date: r.created_at,
        type: r.display_type,
        amount_cents: parseInt(r.amount_cents, 10) || 0,
        status: r.status || null,
        meta: r.meta || null,
        position_details: r.display_type === 'position_close' ? {
          side: r.pos_side,
          order_type: r.pos_order_type,
          size: r.pos_size,
          symbol: r.pos_symbol,
          margin: r.pos_margin,
          placed_price_cents: r.pos_placed_price,
          close_price_cents: r.pos_close_price,
          stop_loss_cents: r.pos_sl,
          take_profit_cents: r.pos_tp
        } : null
      })),
    });
  } catch (err) {
    console.error("transactions list error", err);
    res.status(500).json({ error: "transactions_list_failed" });
  }
});

// KYC submission (insert a new kyc_submissions row). Accepts the expanded KYC fields.
router.post("/kyc/submit", requireAuth, async (req, res) => {
  try {
    const {
      date_of_birth,
      phone,
      country,
      city_state,
      street,
      employer_company,
      employer_city,
      id_number,
    } = req.body;
    // id_number is optional during incremental KYC submissions
    const db = getDb();
    // If the user already has a KYC row, update it instead of inserting a new one.
    const existing = await db.query(
      "SELECT id FROM kyc_submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
      [req.user.userId],
    );
    let kycRow;
    if (existing.rowCount > 0) {
      const id = existing.rows[0].id;
      const upd = await db.query(
        `UPDATE kyc_submissions SET date_of_birth=$1, phone=$2, country=$3, city_state=$4, street=$5, employer_company=$6, employer_city=$7, id_number=$8, status=$9 WHERE id=$10 RETURNING *`,
        [
          date_of_birth || null,
          phone || null,
          country || null,
          city_state || null,
          street || null,
          employer_company || null,
          employer_city || null,
          id_number || null,
          "pending",
          id,
        ],
      );
      kycRow = upd.rows[0];
    } else {
      const insertQ = await db.query(
        `INSERT INTO kyc_submissions (user_id, date_of_birth, phone, country, city_state, street, employer_company, employer_city, id_number, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *`,
        [
          req.user.userId,
          date_of_birth || null,
          phone || null,
          country || null,
          city_state || null,
          street || null,
          employer_company || null,
          employer_city || null,
          id_number,
          "pending",
        ],
      );
      kycRow = insertQ.rows[0];
    }
    res.json({ ok: true, kyc: kycRow });
  } catch (err) {
    console.error("kyc submit error", err);
    res.status(500).json({ error: "kyc_submit_failed" });
  }
});

router.get("/kyc/status", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const q = await db.query(
      "SELECT * FROM kyc_submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
      [req.user.userId],
    );
    if (q.rowCount === 0) return res.json({ status: "not_submitted" });
    res.json(q.rows[0]);
  } catch (err) {
    console.error("kyc status error", err);
    res.status(500).json({ error: "kyc_status_failed" });
  }
});

// Favorite symbols management
router.get("/favorites", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const q = await db.query(
      "SELECT symbol, created_at FROM user_favorite_symbols WHERE user_id=$1 ORDER BY created_at DESC",
      [req.user.userId],
    );
    res.json(q.rows.map((r) => r.symbol));
  } catch (err) {
    console.error("favorites list error", err);
    res.status(500).json({ error: "favorites_list_failed" });
  }
});

router.post("/favorites", requireAuth, async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol || typeof symbol !== "string")
      return res.status(400).json({ error: "invalid_symbol" });
    const db = getDb();
    // upsert to avoid duplicates
    await db.query(
      `INSERT INTO user_favorite_symbols (user_id, symbol, created_at)
       VALUES ($1,$2,NOW()) ON CONFLICT (user_id, symbol) DO NOTHING`,
      [req.user.userId, symbol.toUpperCase()],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("favorites add error", err);
    res.status(500).json({ error: "favorites_add_failed" });
  }
});

router.delete("/favorites/:symbol", requireAuth, async (req, res) => {
  try {
    const symbol = req.params.symbol;
    if (!symbol) return res.status(400).json({ error: "invalid_symbol" });
    const db = getDb();
    await db.query(
      "DELETE FROM user_favorite_symbols WHERE user_id=$1 AND symbol=$2",
      [req.user.userId, symbol.toUpperCase()],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("favorites delete error", err);
    res.status(500).json({ error: "favorites_delete_failed" });
  }
});

function syncBalance(userId, balance) {
  const payload = { 
    user_id: userId, 
    balance_cents: balance.toString() 
  };
  notifyAdmin("admin_user_balance_update", payload);
  notifyUser(userId, "wallet_updated", payload);
}

global.syncBalance = syncBalance; 

router.syncBalance = syncBalance; 

module.exports = router;
