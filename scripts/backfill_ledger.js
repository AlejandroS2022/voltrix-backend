// Backfill script: populate `ledger` table from existing deposits and withdrawals
// Usage: node scripts/backfill_ledger.js

const { initDb, getDb } = require('../src/db');

async function backfill() {
  await initDb();
  const db = getDb();

  let depositCount = 0;
  let withdrawCount = 0;

  try {
    // Deposits
    const deps = await db.query('SELECT id, user_id, amount_cents, reference, status, created_at FROM deposits');
    for (const d of deps.rows) {
      const ref = d.reference || (`deposit-${d.id}`);
      const exists = await db.query('SELECT 1 FROM ledger WHERE reference=$1 LIMIT 1', [ref]);
      if (exists.rowCount > 0) continue;
      const before = 0;
      const after = Number(d.amount_cents || 0);
      await db.query(
        `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta, reference, status, created_at)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [d.user_id, d.amount_cents, before, after, 'deposit', JSON.stringify({ deposit_id: d.id }), ref, d.status || 'completed', d.created_at]
      );
      depositCount++;
    }

    // Withdrawals
    const wds = await db.query('SELECT id, user_id, amount_cents, status, created_at FROM withdrawals');
    for (const w of wds.rows) {
      const ref = String(w.id);
      const exists = await db.query('SELECT 1 FROM ledger WHERE reference=$1 LIMIT 1', [ref]);
      if (exists.rowCount > 0) continue;
      const before = 0;
      const after = -Number(w.amount_cents || 0);
      await db.query(
        `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta, reference, status, created_at)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [w.user_id, -w.amount_cents, before, after, 'withdrawal', JSON.stringify({ withdrawal_id: w.id }), ref, w.status || 'pending', w.created_at]
      );
      withdrawCount++;
    }

    console.log(`Backfill complete: deposits=${depositCount}, withdrawals=${withdrawCount}`);
    process.exit(0);
  } catch (err) {
    console.error('Backfill failed', err);
    process.exit(1);
  }
}

backfill();
