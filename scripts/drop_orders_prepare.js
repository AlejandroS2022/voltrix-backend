require('dotenv').config();
const { initDb } = require('../src/db');

async function run() {
  const pool = await initDb();
  const client = pool;
  try {
    // rename orders and holds to archive names (safe non-destructive step)
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const ordersArchive = `orders_archive_${ts}`;
    const holdsArchive = `holds_archive_${ts}`;

    console.log('Renaming orders ->', ordersArchive);
    await client.query(`ALTER TABLE IF EXISTS orders RENAME TO ${ordersArchive}`);
    console.log('Renaming holds ->', holdsArchive);
    await client.query(`ALTER TABLE IF EXISTS holds RENAME TO ${holdsArchive}`);

    // drop foreign key constraints in trades that reference orders (if they exist)
    console.log('Dropping foreign key constraints on trades (if any)');
    await client.query(`ALTER TABLE IF EXISTS trades DROP CONSTRAINT IF EXISTS trades_buy_order_id_fkey`);
    await client.query(`ALTER TABLE IF EXISTS trades DROP CONSTRAINT IF EXISTS trades_sell_order_id_fkey`);

    console.log('Migration preparation to remove orders completed. Table data preserved in archives.');
    process.exit(0);
  } catch (err) {
    console.error('Failed to prepare drop orders migration', err);
    process.exit(1);
  }
}

run();
