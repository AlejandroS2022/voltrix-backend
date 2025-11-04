const { broadcastTrade } = require('../socket');
const { getDb } = require('../db');

// Basic in-DB matching engine (for simplicity)
async function placeOrder(userId, side, price_cents, size) {
  const db = getDb();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Insert the order
    const insertRes = await client.query(
      `INSERT INTO orders (user_id, side, price_cents, size, status, created_at)
       VALUES ($1, $2, $3, $4, 'open', NOW())
       RETURNING *`,
      [userId, side, price_cents, size]
    );
    const newOrder = insertRes.rows[0];

    let matchQuery;
    if (side === 'buy') {
      // Look for the lowest sell order <= buy price
      matchQuery = `
        SELECT * FROM orders
        WHERE side='sell' AND price_cents <= $1 AND status='open'
        ORDER BY price_cents ASC, created_at ASC
        LIMIT 1
      `;
    } else {
      // Look for the highest buy order >= sell price
      matchQuery = `
        SELECT * FROM orders
        WHERE side='buy' AND price_cents >= $1 AND status='open'
        ORDER BY price_cents DESC, created_at ASC
        LIMIT 1
      `;
    }

    const matchRes = await client.query(matchQuery, [price_cents]);
    const matchOrder = matchRes.rows[0];

    if (matchOrder) {
      // Execute a trade
      const tradePrice = matchOrder.price_cents; // can use mid or taker price logic later
      const tradeSize = Math.min(size, matchOrder.size);

      await client.query(
        `INSERT INTO trades (buy_order_id, sell_order_id, price_cents, size, executed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          side === 'buy' ? newOrder.id : matchOrder.id,
          side === 'buy' ? matchOrder.id : newOrder.id,
          tradePrice,
          tradeSize,
        ]
      );

      // Update matched order
      await client.query(
        `UPDATE orders SET status='filled' WHERE id=$1`,
        [matchOrder.id]
      );

      // Update new order
      await client.query(
        `UPDATE orders SET status='filled' WHERE id=$1`,
        [newOrder.id]
      );

      // Update balances (very simplified)
      if (side === 'buy') {
        // Deduct buyer funds
        await client.query(
          `UPDATE wallets SET balance_cents = balance_cents - $1 WHERE user_id=$2`,
          [tradePrice * tradeSize, userId]
        );
        // Add seller funds
        await client.query(
          `UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id=$2`,
          [tradePrice * tradeSize, matchOrder.user_id]
        );
      } else {
        // Deduct buyer funds
        await client.query(
          `UPDATE wallets SET balance_cents = balance_cents - $1 WHERE user_id=$2`,
          [tradePrice * tradeSize, matchOrder.user_id]
        );
        // Add seller funds
        await client.query(
          `UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id=$2`,
          [tradePrice * tradeSize, userId]
        );
      }

      await client.query('COMMIT');
      broadcastTrade({ tradePrice, tradeSize, ts: Date.now() });
      return { matched: true, tradePrice, tradeSize };
    } else {
      await client.query('COMMIT');
      return { matched: false, orderId: newOrder.id };
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Matching engine error:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { placeOrder };
