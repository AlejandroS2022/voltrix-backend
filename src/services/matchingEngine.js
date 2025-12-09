const { getDb } = require('../db');
const { broadcastTrade } = require('../socket');
const { v4: uuidv4 } = require('uuid');

async function placeOrder({ userId, side, order_type = 'limit', price_cents = null, size, stop_loss_cents = null, take_profit_cents = null, symbol = 'BTCUSD' }) {
  // size is numeric (units), price_cents is integer for limit orders; market orders have price_cents == null
  const db = getDb();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // No orders table in position model: we will create positions directly.
    let remainingSize = Number(size);
    const orderId = null;

    // In position model, we'll create a position when an order executes. For limit orders that don't execute immediately,
    // we leave the order open. For market orders (or limit orders that match current price) we create a position and debit wallet.

    // Helper to fetch last trade price
    async function getLastPrice() {
      const pQ = await client.query('SELECT price_cents FROM trades WHERE symbol=$1 ORDER BY executed_at DESC LIMIT 1', [symbol]);
      if (pQ.rowCount) return pQ.rows[0].price_cents;
      return null;
    }

    async function openPosition(entryPriceCents, placedPriceCents = null) {
      // 1) create position record
      const posRes = await client.query(
        `INSERT INTO positions (user_id, symbol, side, size, entry_price_cents, placed_price_cents, stop_loss_cents, take_profit_cents, order_type, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',NOW()) RETURNING *`,
        [userId, symbol, side, size, entryPriceCents, placedPriceCents, stop_loss_cents, take_profit_cents, order_type]
      );
      const position = posRes.rows[0];

      // 2) charge user: deduct entry_price * size from wallet
      const entryAmount = Math.ceil(entryPriceCents * Number(size));
      const wq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [userId]);
      const balance = BigInt(wq.rows[0]?.balance_cents || 0);
      const cost = BigInt(entryAmount);
      if (balance < cost) {
        // remove created position record
        await client.query('DELETE FROM positions WHERE id=$1', [position.id]);
        await client.query('ROLLBACK');
        return { error: 'insufficient_funds' };
      }
      const balanceBefore = balance;
      const balanceAfter = balance - cost;
      await client.query('UPDATE wallets SET balance_cents=$1 WHERE user_id=$2', [balanceAfter.toString(), userId]);
      await client.query(
        `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [userId, null, -entryAmount, balanceBefore.toString(), balanceAfter.toString(), 'position_open', JSON.stringify({ position_id: position.id, symbol, entry_price_cents: entryPriceCents })]
      );

      // position opened; nothing to mark on orders since orders are removed
      return { ok: true, positionId: position.id };
    }

    // Decide execution for market orders or immediate limit fills
    // normalize symbol to uppercase
    symbol = (symbol || 'BTCUSD').toUpperCase();
    const lastPrice = await getLastPrice();
    // Broker order placement disabled: execute locally within platform using last known price or pending logic
    if (order_type === 'market') {
      if (!lastPrice) {
        await client.query('ROLLBACK');
        return { error: 'no_price_available' };
      }
      // Open position at lastPrice
      const res = await openPosition(lastPrice, lastPrice);
      if (res.error) return res;
      await client.query('COMMIT');
      return res;
    } else {
      // limit: if price crosses lastPrice then execute immediately, otherwise keep order open
      if (lastPrice && ((side === 'buy' && lastPrice <= price_cents) || (side === 'sell' && lastPrice >= price_cents))) {
        const res = await openPosition(price_cents);
        if (res.error) return res;
        await client.query('COMMIT');
        return res;
      } else {
        // create a pending position that will be activated when price reaches entry (external worker needed)
        const pending = await client.query(
          `INSERT INTO positions (user_id, symbol, side, size, entry_price_cents, placed_price_cents, stop_loss_cents, take_profit_cents, order_type, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW()) RETURNING *`,
          [userId, symbol, side, size, price_cents, lastPrice, stop_loss_cents, take_profit_cents, order_type]
        );
        await client.query('COMMIT');
        return { ok: true, pending: true, positionId: pending.rows[0].id };
      }
    }

    // No holds logic in simple position model; funds are captured on openPosition

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

async function closePosition({ positionId, closePriceCents = null }) {
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const pq = await client.query('SELECT * FROM positions WHERE id=$1 FOR UPDATE', [positionId]);
    if (pq.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'position_not_found' };
    }
    const pos = pq.rows[0];
    if (pos.status !== 'open') {
      await client.query('ROLLBACK');
      return { error: 'position_not_open' };
    }

    // determine close price
    let closePrice = closePriceCents;
    if (closePrice === null || closePrice === undefined) {
      const lp = await client.query('SELECT price_cents FROM trades WHERE symbol=$1 ORDER BY executed_at DESC LIMIT 1', [pos.symbol]);
      if (lp.rowCount === 0) {
        await client.query('ROLLBACK');
        return { error: 'no_price_available' };
      }
      closePrice = lp.rows[0].price_cents;
    }

    const entryPrice = Number(pos.entry_price_cents);
    const sizeNum = Number(pos.size);
    const entryAmount = BigInt(Math.ceil(entryPrice * sizeNum));
    const closeAmount = BigInt(Math.ceil(closePrice * sizeNum));
    const pnl = closeAmount - entryAmount;

    // credit user wallet with closeAmount
    const wq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [pos.user_id]);
    const before = BigInt(wq.rows[0]?.balance_cents || 0);
    const after = before + closeAmount;
    await client.query('UPDATE wallets SET balance_cents=$1 WHERE user_id=$2', [after.toString(), pos.user_id]);

    // ledger entry
    await client.query(
      `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [pos.user_id, null, Number(closeAmount), before.toString(), after.toString(), 'position_close', JSON.stringify({ position_id: pos.id, close_price_cents: closePrice })]
    );

    // update position
    await client.query('UPDATE positions SET status=$1, closed_at=NOW(), close_price_cents=$2, realized_pnl_cents=$3 WHERE id=$4', ['closed', closePrice, Number(pnl), pos.id]);

    // insert a trade record for the close (no counterparty)
    await client.query(
      `INSERT INTO trades (buy_order_id, sell_order_id, price_cents, size, executed_at, symbol)
       VALUES ($1,$2,$3,$4,NOW(),$5)`,
      [null, null, closePrice, sizeNum, pos.symbol]
    );

    await client.query('COMMIT');
    return { ok: true, positionId: pos.id, pnl: Number(pnl) };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('closePosition error', err);
    throw err;
  } finally {
    client.release();
  }
}

// compatibility wrapper: allow either placeOrder({ ... }) or placeOrder(userId, side, price_cents, size, symbol)
async function placeOrderCompat(...args) {
  if (args.length === 1 && typeof args[0] === 'object') {
    return placeOrder(args[0]);
  }
  // positional signature (legacy): userId, side, price_cents, size, symbol
  const [userId, side, price_cents, size, symbol] = args;
  return placeOrder({ userId, side, order_type: 'limit', price_cents, size, symbol });
}

module.exports = { placeOrder: placeOrderCompat, closePosition };

async function activatePendingPosition({ positionId, marketPriceCents }) {
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const pq = await client.query('SELECT * FROM positions WHERE id=$1 FOR UPDATE', [positionId]);
    if (pq.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'position_not_found' };
    }
    const pos = pq.rows[0];
    if (pos.status !== 'pending') {
      await client.query('ROLLBACK');
      return { error: 'position_not_pending' };
    }

    const entryPrice = Number(pos.entry_price_cents);
    const execPrice = marketPriceCents || entryPrice;
    const sizeNum = Number(pos.size);
    const entryAmount = BigInt(Math.ceil(execPrice * sizeNum));

    // charge user
    const wq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [pos.user_id]);
    const balance = BigInt(wq.rows[0]?.balance_cents || 0);
    if (balance < entryAmount) {
      // mark pending as cancelled due to insufficient funds
      await client.query("UPDATE positions SET status=$1 WHERE id=$2", ['cancelled', pos.id]);
      await client.query('COMMIT');
      return { error: 'insufficient_funds' };
    }

    const balanceBefore = balance;
    const balanceAfter = balance - entryAmount;
    await client.query('UPDATE wallets SET balance_cents=$1 WHERE user_id=$2', [balanceAfter.toString(), pos.user_id]);

    await client.query(
      `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [pos.user_id, null, -Number(entryAmount), balanceBefore.toString(), balanceAfter.toString(), 'position_open', JSON.stringify({ position_id: pos.id, symbol: pos.symbol, entry_price_cents: execPrice })]
    );

    // update position to open and set actual entry price
    await client.query('UPDATE positions SET status=$1, entry_price_cents=$2, created_at=COALESCE(created_at,NOW()) WHERE id=$3', ['open', execPrice, pos.id]);

    // record a trade for the open (no counterparty)
    await client.query(
      `INSERT INTO trades (buy_order_id, sell_order_id, price_cents, size, executed_at, symbol)
       VALUES ($1,$2,$3,$4,NOW(),$5)`,
      [null, null, execPrice, sizeNum, pos.symbol]
    );

    await client.query('COMMIT');
    return { ok: true, positionId: pos.id };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('activatePendingPosition error', err);
    throw err;
  } finally {
    client.release();
  }
}

// export activation helper
module.exports.activatePendingPosition = activatePendingPosition;