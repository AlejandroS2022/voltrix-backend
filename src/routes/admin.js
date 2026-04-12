const express = require("express");
const router = express.Router();
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { invalidateFeeCache } = require("../services/priceStream");

const otherRouter = require("./trading");
const syncBalance = otherRouter.syncBalance;

async function requireAdmin(req, res, next) {
  try {
    const db = getDb();
    const q = await db.query("SELECT is_admin FROM users WHERE id=$1", [
      req.user.userId,
    ]);
    if (q.rowCount === 0) return res.status(403).json({ error: "forbidden" });
    if (!q.rows[0].is_admin)
      return res.status(403).json({ error: "admin_required" });
    return next();
  } catch (err) {
    console.error("requireAdmin error", err);
    return res.status(500).json({ error: "admin_check_failed" });
  }
}

// Fees management
router.get("/fees", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const q = await db.query(
      "SELECT id, symbol, fee_type, fee_value FROM symbol_fees ORDER BY symbol",
    );
    res.json(q.rows);
  } catch (err) {
    console.error("fetch fees error", err);
    res.status(500).json({ error: "fetch_fees_failed" });
  }
});

// upsert fee for a symbol
router.post("/fees", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { symbol, fee_type, fee_value } = req.body;
    if (!symbol || !fee_type || typeof fee_value === "undefined")
      return res.status(400).json({ error: "invalid_payload" });
    const db = getDb();
    const q = await db.query(
      "SELECT id FROM symbol_fees WHERE symbol=$1 LIMIT 1",
      [symbol.toUpperCase()],
    );
    if (q.rowCount === 0) {
      await db.query(
        "INSERT INTO symbol_fees (symbol, fee_type, fee_value, created_at, updated_at) VALUES ($1,$2,$3,NOW(),NOW())",
        [symbol.toUpperCase(), fee_type, fee_value],
      );
    } else {
      await db.query(
        "UPDATE symbol_fees SET fee_type=$1, fee_value=$2, updated_at=NOW() WHERE symbol=$3",
        [fee_type, fee_value, symbol.toUpperCase()],
      );
    }
    // invalidate in-memory fee cache so next tick picks up the change
    try {
      invalidateFeeCache(symbol);
    } catch (e) {
      console.warn("invalidate fee cache failed", e);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("upsert fee error", err);
    res.status(500).json({ error: "upsert_fee_failed" });
  }
});

// delete a fee by id
router.delete("/fees/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = getDb();
    const q = await db.query(
      "SELECT symbol FROM symbol_fees WHERE id=$1 LIMIT 1",
      [id],
    );
    if (q.rowCount === 0) return res.status(404).json({ error: "not_found" });
    const symbol = q.rows[0].symbol;
    await db.query("DELETE FROM symbol_fees WHERE id=$1", [id]);
    try {
      invalidateFeeCache(symbol);
    } catch (e) {
      console.warn("invalidate fee cache failed", e);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("delete fee error", err);
    res.status(500).json({ error: "delete_fee_failed" });
  }
});

// KYC admin endpoints: list submissions and approve/reject
router.get("/kyc", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const q = await db.query(
      `SELECT * FROM kyc_submissions ORDER BY created_at DESC LIMIT 200`,
    );
    res.json(q.rows);
  } catch (err) {
    console.error("fetch kyc error", err);
    res.status(500).json({ error: "fetch_kyc_failed" });
  }
});

router.post("/kyc/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = getDb();
    await db.query("UPDATE kyc_submissions SET status=$1 WHERE id=$2", [
      "approved",
      id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error("approve kyc error", err);
    res.status(500).json({ error: "approve_failed" });
  }
});

router.post("/kyc/:id/reject", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = getDb();
    await db.query("UPDATE kyc_submissions SET status=$1 WHERE id=$2", [
      "rejected",
      id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error("reject kyc error", err);
    res.status(500).json({ error: "reject_failed" });
  }
});

router.get("/all-positions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.page_size || "20", 10), 1),
      100,
    );
    const offset = (page - 1) * pageSize;

    const totalRes = await db.query(
      `SELECT COUNT(1) AS total
         FROM positions p
         JOIN users u ON p.user_id = u.id
         WHERE p.status = 'open'`,
    );
    const total = parseInt(totalRes.rows[0].total, 10) || 0;

    const q = await db.query(
      `SELECT p.id, p.user_id, u.email, p.symbol, p.side, p.size, p.entry_price_cents, p.placed_price_cents, p.order_type, p.stop_loss_cents, p.take_profit_cents, p.status, p.realized_pnl_cents, p.created_at, p.closed_at, p.close_price_cents
         FROM positions p
         JOIN users u ON p.user_id = u.id
         WHERE p.status = 'open'
         ORDER BY p.created_at DESC
         LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    );
    res.json({
      page,
      page_size: pageSize,
      total,
      data: q.rows,
    });
  } catch (err) {
    console.error("admin all-positions error", err);
    res.status(500).json({ error: "all_positions_failed" });
  }
});

router.patch("/positions/:id", requireAuth, requireAdmin, async (req, res) => {
  const db = getDb();
  const positionId = req.params.id;
  const allowedFields = [
    "symbol",
    "side",
    "order_type",
    "size",
    "entry_price_cents",
    "placed_price_cents",
    "stop_loss_cents",
    "take_profit_cents",
    "status",
    "realized_pnl_cents",
    "close_price_cents",
    "closed_at",
  ];
  const updates = [];
  const values = [];
  let idx = 1;
  for (const field of allowedFields) {
    if (field in req.body) {
      updates.push(`${field}=$${idx}`);
      values.push(req.body[field]);
      idx++;
    }
  }
  if (updates.length === 0)
    return res.status(400).json({ error: "no_fields_to_update" });
  values.push(positionId);
  try {
    await db.query(
      `UPDATE positions SET ${updates.join(", ")} WHERE id=$${idx}`,
      values,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("admin position edit error", err);
    res.status(500).json({ error: "admin_position_edit_failed" });
  }
});

/**
 * ADMIN: List all users in the system
 * GET /admin/users
 * Requires admin privileges
 */
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.page_size || "20", 10), 1),
      100,
    );
    const offset = (page - 1) * pageSize;

    const totalRes = await db.query("SELECT COUNT(1) AS total FROM users");
    const total = parseInt(totalRes.rows[0].total, 10) || 0;

    const q = await db.query(
      `SELECT 
        u.id, u.email, u.first_name, u.last_name, u.created_at, u.is_admin,
        COALESCE(w.balance_cents, 0) AS balance_cents
       FROM users u
       LEFT JOIN wallets w ON u.id = w.user_id
       ORDER BY u.created_at DESC 
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    );

    res.json({
      page,
      page_size: pageSize,
      total,
      data: q.rows,
    });
  } catch (err) {
    console.error("admin users list error", err);
    res.status(500).json({ error: "users_list_failed" });
  }
});

router.post(
  "/users/:id/balance",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { balance_cents } = req.body;
    const userId = req.params.id;
    const db = getDb();

    if (
      typeof balance_cents === "undefined" ||
      isNaN(parseInt(balance_cents))
    ) {
      return res.status(400).json({ error: "invalid_balance_value" });
    }

    try {
      await db.query(
        "UPDATE wallets SET balance_cents = $1 WHERE user_id = $2",
        [parseInt(balance_cents, 10), userId],
      );

      syncBalance(userId, balance_cents);

      res.json({ ok: true, balance_cents });
    } catch (err) {
      console.error("Update balance error:", err);
      res.status(500).json({ error: "failed_to_update_balance" });
    }
  },
);

router.post(
  "/users/:id/toggle-admin",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const targetUserId = req.params.id;
    const adminId = req.user.userId;

    if (String(targetUserId) === String(adminId)) {
      return res.status(400).json({ error: "cannot_toggle_self" });
    }

    const db = getDb();
    try {
      const result = await db.query(
        "UPDATE users SET is_admin = NOT is_admin WHERE id = $1 RETURNING is_admin",
        [targetUserId],
      );

      if (result.rowCount === 0)
        return res.status(404).json({ error: "user_not_found" });

      res.json({ ok: true, is_admin: result.rows[0].is_admin });
    } catch (err) {
      console.error("Toggle admin error:", err);
      res.status(500).json({ error: "failed_to_toggle_admin" });
    }
  },
);

module.exports = router;
