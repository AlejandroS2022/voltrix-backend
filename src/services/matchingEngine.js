const { getDb } = require('../db');
const { broadcastTrade } = require('../socket');
const { v4: uuidv4 } = require('uuid');

async function placeOrder({ userId, side, price_cents, size, symbol = 'BTCUSD' }) {
  // size is numeric (units), price_cents is integer
  const db = getDb();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1) Insert order
    const insertRes = await client.query(
      `INSERT INTO orders (user_id, side, price_cents, size, status, created_at, symbol)
       VALUES ($1,$2,$3,$4,'open',NOW(),$5) RETURNING *`,
      [userId, side, price_cents, size, symbol]
    );
    let remainingSize = parseFloat(insertRes.rows[0].size);
    const orderId = insertRes.rows[0].id;

    // 2) If BUY: reserve funds (price * size)
    if (side === 'buy') {
      const costCents = Math.ceil(price_cents * remainingSize); // ensure cents
      // lock wallet row
      const wq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [userId]);
      const balance = BigInt(wq.rows[0]?.balance_cents || 0);
      const cost = BigInt(costCents);
      if (balance < cost) {
        await client.query('ROLLBACK');
        return { error: 'insufficient_funds' };
      }
      const balanceBefore = balance;
      const balanceAfter = balance - cost;
      await client.query('UPDATE wallets SET balance_cents = $1 WHERE user_id=$2', [balanceAfter.toString(), userId]);
      await client.query('INSERT INTO holds (user_id, order_id, amount_cents) VALUES ($1,$2,$3)', [userId, orderId, costCents]);

      // ledger
      await client.query(
        `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [userId, orderId, -costCents, balanceBefore.toString(), balanceAfter.toString(), 'reserve', JSON.stringify({ symbol, price_cents })]
      );
    }

    // 3) Match loop: find best opposite orders and execute trades until remainingSize == 0 or nothing to match
    while (remainingSize > 0) {
      let matchQuery;
      if (side === 'buy') {
        // find lowest price sell order <= buy price
        matchQuery = `
          SELECT id, user_id, price_cents, size FROM orders
          WHERE side='sell' AND status='open' AND symbol=$1 AND price_cents <= $2
          ORDER BY price_cents ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
      } else {
        matchQuery = `
          SELECT id, user_id, price_cents, size FROM orders
          WHERE side='buy' AND status='open' AND symbol=$1 AND price_cents >= $2
          ORDER BY price_cents DESC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
      }

      const mq = await client.query(matchQuery, [symbol, price_cents]);
      if (mq.rowCount === 0) break; // nothing to match

      const matchOrder = mq.rows[0];
      const matchSize = parseFloat(matchOrder.size);
      const executedSize = Math.min(remainingSize, matchSize);
      const tradePrice = matchOrder.price_cents; // taker accepts maker price (match price)

      // create trade record
      await client.query(
        `INSERT INTO trades (buy_order_id, sell_order_id, price_cents, size, executed_at, symbol)
         VALUES ($1,$2,$3,$4,NOW(),$5)`,
        [
          side === 'buy' ? orderId : matchOrder.id,
          side === 'buy' ? matchOrder.id : orderId,
          tradePrice,
          executedSize,
          symbol
        ]
      );

      // ledger updates & wallet transfers
      // Buyer: funds already reserved in holds (if buyer is current order and side==='buy', else if buyer is matchOrder user must deduct now)
      const tradeAmountCents = Math.ceil(tradePrice * executedSize);

      // ensure numeric bigints for DB
      // For buyer:
      if (side === 'buy') {
        // buyer = userId (current order) — reserved funds exist
        // release portion of hold and keep the spent amount removed from hold
        // Reduce hold amount by tradeAmountCents
        const holdRow = await client.query('SELECT id, amount_cents FROM holds WHERE order_id=$1 FOR UPDATE', [orderId]);
        if (holdRow.rowCount) {
          const currentHold = BigInt(holdRow.rows[0].amount_cents);
          const newHold = currentHold - BigInt(tradeAmountCents);
          if (newHold < 0n) {
            // shouldn't happen: just keepng for safety
            await client.query('ROLLBACK');
            throw new Error('Hold underflow');
          }
          if (newHold === 0n) {
            await client.query('DELETE FROM holds WHERE id=$1', [holdRow.rows[0].id]);
          } else {
            await client.query('UPDATE holds SET amount_cents=$1 WHERE id=$2', [newHold.toString(), holdRow.rows[0].id]);
          }
        } else {
          // maybe buyer was maker (matchOrder) otherwise handle
        }

        // Credit seller wallet
        const sellerWalletBeforeQ = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [matchOrder.user_id]);
        const sellerBefore = BigInt(sellerWalletBeforeQ.rows[0]?.balance_cents || 0);
        const sellerAfter = sellerBefore + BigInt(tradeAmountCents);
        await client.query('UPDATE wallets SET balance_cents=$1 WHERE user_id=$2', [sellerAfter.toString(), matchOrder.user_id]);

        // ledger entries
        await client.query(
          `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [matchOrder.user_id, matchOrder.id, tradeAmountCents, sellerBefore.toString(), sellerAfter.toString(), 'trade_in', JSON.stringify({ from: userId, symbol })]
        );
      } else {
        // side === 'sell' (current order is seller)
        // Buyer is matchOrder.user_id — they likely reserved funds or have wallet funds
        // For buyer (matchOrder.user_id): deduct funds now (if reserved earlier, reduce their hold)
        const buyerId = matchOrder.user_id;
        // attempt to reduce buy order's hold
        const buyerHoldQ = await client.query('SELECT id, amount_cents, order_id FROM holds WHERE order_id=$1 FOR UPDATE', [matchOrder.id]);
        if (buyerHoldQ.rowCount) {
          const holdRow = buyerHoldQ.rows[0];
          const currentHold = BigInt(holdRow.amount_cents);
          const newHold = currentHold - BigInt(tradeAmountCents);
          if (newHold < 0n) {
            await client.query('ROLLBACK');
            throw new Error('Buyer hold underflow');
          }
          if (newHold === 0n) {
            await client.query('DELETE FROM holds WHERE id=$1', [holdRow.id]);
          } else {
            await client.query('UPDATE holds SET amount_cents=$1 WHERE id=$2', [newHold.toString(), holdRow.id]);
          }
        } else {
          // if no hold found, attempt to deduct directly (should be rare)
          const wq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [buyerId]);
          const before = BigInt(wq.rows[0]?.balance_cents || 0);
          if (before < BigInt(tradeAmountCents)) {
            await client.query('ROLLBACK');
            return { error: 'buyer_insufficient_after_attempt' };
          }
          const after = before - BigInt(tradeAmountCents);
          await client.query('UPDATE wallets SET balance_cents=$1 WHERE user_id=$2', [after.toString(), buyerId]);
          await client.query(
            `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [buyerId, matchOrder.id, -tradeAmountCents, before.toString(), after.toString(), 'trade_out', JSON.stringify({ to: userId, symbol })]
          );
        }

        // Credit seller (current user)
        const sellerWq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [userId]);
        const sellerBefore = BigInt(sellerWq.rows[0]?.balance_cents || 0);
        const sellerAfter = sellerBefore + BigInt(tradeAmountCents);
        await client.query('UPDATE wallets SET balance_cents=$1 WHERE user_id=$2', [sellerAfter.toString(), userId]);
        await client.query(
          `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [userId, orderId, tradeAmountCents, sellerBefore.toString(), sellerAfter.toString(), 'trade_in', JSON.stringify({ from: buyerId, symbol })]
        );
      }

      // 4) adjust matched order sizes and statuses
      const newMatchRemaining = parseFloat(matchSize) - executedSize;
      if (newMatchRemaining <= 0) {
        await client.query(`UPDATE orders SET status='filled', size=0 WHERE id=$1`, [matchOrder.id]);
      } else {
        await client.query(`UPDATE orders SET size=$1 WHERE id=$2`, [newMatchRemaining, matchOrder.id]);
      }

      remainingSize = remainingSize - executedSize;
      const newOrderRemaining = remainingSize;
      if (newOrderRemaining <= 0) {
        await client.query(`UPDATE orders SET status='filled', size=0 WHERE id=$1`, [orderId]);
      } else {
        await client.query(`UPDATE orders SET size=$1 WHERE id=$2`, [newOrderRemaining, orderId]);
      }

      // Broadcast trade to sockets
      const tradeMsg = {
        symbol,
        price_cents: tradePrice,
        size: executedSize,
        buy_order_id: side === 'buy' ? orderId : matchOrder.id,
        sell_order_id: side === 'buy' ? matchOrder.id : orderId,
        ts: Date.now()
      };
      broadcastTrade(tradeMsg);
      // continue loop for remaining size
    } // end match loop

    // 4) If buy order still has remaining size, adjust holds to only reserve remaining amount
    if (side === 'buy') {
      // compute reserved vs necessary
      const holdQ = await client.query('SELECT id, amount_cents FROM holds WHERE order_id=$1 FOR UPDATE', [orderId]);
      if (holdQ.rowCount) {
        const holdRow = holdQ.rows[0];
        // desired reserved amount = remainingSize * price_cents
        const desiredReserve = Math.ceil(price_cents * remainingSize);
        const currentReserve = BigInt(holdRow.amount_cents);
        const desiredReserveB = BigInt(desiredReserve);
        if (desiredReserveB < currentReserve) {
          const diff = currentReserve - desiredReserveB;
          // release diff back to wallet
          const wq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [userId]);
          const before = BigInt(wq.rows[0]?.balance_cents || 0);
          const after = before + diff;
          await client.query('UPDATE wallets SET balance_cents=$1 WHERE user_id=$2', [after.toString(), userId]);
          if (desiredReserveB === 0n) {
            await client.query('DELETE FROM holds WHERE id=$1', [holdRow.id]);
          } else {
            await client.query('UPDATE holds SET amount_cents=$1 WHERE id=$2', [desiredReserve.toString(), holdRow.id]);
          }
          await client.query(
            `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [userId, orderId, Number(diff * 1n), before.toString(), after.toString(), 'release', JSON.stringify({ symbol })]
          );
        }
      }
    }

    await client.query('COMMIT');
    return { ok: true, orderId, remaining: remainingSize };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('orderbook error', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { placeOrder };