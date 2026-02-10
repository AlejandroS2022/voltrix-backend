const { getDb } = require('../db');

async function writeLedger(dbOrUser, payload) {
  // writeLedger(db, {...}) or writeLedger(userId, {...})
  let db;
  if (typeof dbOrUser === 'object' && dbOrUser.query) {
    db = dbOrUser;
  } else {
    const { initDb, getDb } = require('../db');
    await initDb();
    db = getDb();
  }

  const {
    userId,
    related_order_id = null,
    change_cents = 0,
    balance_before = 0,
    balance_after = 0,
    type = 'ledger',
    meta = null,
    reference = null,
    status = null,
  } = typeof dbOrUser === 'number' ? payload : payload;

  const q = await db.query(
    `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta, reference, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING id`,
    [userId, related_order_id, change_cents, balance_before, balance_after, type, meta ? JSON.stringify(meta) : null, reference, status]
  );
  return q.rows[0].id;
}

module.exports = { writeLedger };
