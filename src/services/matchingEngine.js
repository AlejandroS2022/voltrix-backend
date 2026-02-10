const { getDb } = require('../db');
const { broadcastTrade, notifyUser } = require('../socket');
const { v4: uuidv4 } = require('uuid');
const redis = require('../config/redis');

// helper: apply symbol fee to a per-unit price (cents) using DB lookup
// direction: 'buy' => increase price (buyer pays fee), 'sell' => decrease price (seller receives less)
async function applyFeeToPrice(perUnitCents, symbol, client, direction = 'buy') {
  if (!symbol) return perUnitCents;
  try {
    const sym = String(symbol).toUpperCase();
    const q = await client.query('SELECT fee_type, fee_value FROM symbol_fees WHERE symbol=$1 LIMIT 1', [sym]);
    if (q.rowCount === 0) return perUnitCents;
    const row = q.rows[0];
    if (row.fee_type === 'percent') {
      const pct = parseFloat(row.fee_value) || 0;
      if (direction === 'buy') return Math.round(perUnitCents * (1 + pct / 100));
      return Math.round(perUnitCents * (1 - pct / 100));
    }
    // fixed: fee_value is decimal dollars, convert to cents
    const fixed = Math.round((parseFloat(row.fee_value) || 0) * 100);
    if (direction === 'buy') return perUnitCents + fixed;
    return Math.max(0, perUnitCents - fixed);
  } catch (err) {
    console.warn('failed to load/apply fee for symbol', symbol, err);
    return perUnitCents;
  }
}

/*
 * Internal trigger for limit orders (same model as pendingActivator):
 * - BUY limit at P: trigger = P - fee. We fill when Binance Ask <= trigger (we buy low, give user P).
 * - SELL limit at P: trigger = P + fee. We fill when Binance Bid >= trigger (we sell high, give user P).
 * Fee: percent (fee_value in %) or fixed (fee_value in dollars, converted to cents).
 */
async function getInternalTriggerPrice(userPriceCents, symbol, client, side) {
  if (!symbol) return userPriceCents;
  try {
    const sym = String(symbol).toUpperCase();
    let q = await client.query('SELECT fee_type, fee_value FROM symbol_fees WHERE symbol=$1 LIMIT 1', [sym]);
    if (q.rowCount === 0 && sym.endsWith('USDT')) {
      q = await client.query('SELECT fee_type, fee_value FROM symbol_fees WHERE symbol=$1 LIMIT 1', [sym.replace(/USDT$/, 'USD')]);
    }
    if (q.rowCount === 0) return userPriceCents;
    const row = q.rows[0];
    let feeCents = 0;
    if (row.fee_type === 'percent') {
      feeCents = Math.round(userPriceCents * (parseFloat(row.fee_value) || 0) / 100);
    } else {
      feeCents = Math.round((parseFloat(row.fee_value) || 0) * 100); // fee_value in dollars
    }
    const sideNorm = String(side || '').toLowerCase();
    return sideNorm === 'buy' ? userPriceCents - feeCents : userPriceCents + feeCents;
  } catch (err) {
    console.warn('failed to calculate trigger price', symbol, err);
    return userPriceCents;
  }
}

async function placeOrder({ userId, side, order_type = 'limit', price_cents = null, size, stop_loss_cents = null, take_profit_cents = null, symbol = 'BTCUSDT' }) {
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
      // Prefer Redis latest tick (most real-time); fallback to trades table
      try {
        const raw = await redis.get(`tick_latest:${symbol}`);
        if (raw) {
          const tick = JSON.parse(raw);
          if (tick) {
            // prefer raw values if available so fees can be applied later
            if (typeof tick.raw_bid_cents === 'number' && typeof tick.raw_ask_cents === 'number') return Math.round((tick.raw_bid_cents + tick.raw_ask_cents) / 2);
            if (typeof tick.raw_bid_cents === 'number') return tick.raw_bid_cents;
            if (typeof tick.raw_ask_cents === 'number') return tick.raw_ask_cents;
            if (typeof tick.price_cents === 'number') return tick.price_cents;
            if (typeof tick.bid_cents === 'number' && typeof tick.ask_cents === 'number') return Math.round((tick.bid_cents + tick.ask_cents) / 2);
            if (typeof tick.bid_cents === 'number') return tick.bid_cents;
            if (typeof tick.ask_cents === 'number') return tick.ask_cents;
          }
        }
      } catch (err) {
        console.warn('redis tick read failed', err);
      }
      // fallback to trades table
      const pQ = await client.query('SELECT price_cents FROM trades WHERE symbol=$1 ORDER BY executed_at DESC LIMIT 1', [symbol]);
      if (pQ.rowCount) return pQ.rows[0].price_cents;
      return null;
    }

    async function openPosition(entryPriceCents, placedPriceCents = null) {
      // entryPriceCents is the per-unit price; compute per-unit including fee then total cost = per-unit_with_fee * size
      const perUnit = Number(entryPriceCents || 0);
      const sizeNum = Number(size || 0);
      const perUnitWithFee = await applyFeeToPrice(perUnit, symbol, client, side);
      const entryCost = Math.ceil(perUnitWithFee * sizeNum);

      // 1) create position record storing entry_price_cents as total cost
      const posRes = await client.query(
        `INSERT INTO positions (user_id, symbol, side, size, entry_price_cents, placed_price_cents, stop_loss_cents, take_profit_cents, order_type, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',NOW()) RETURNING *`,
        // store entry_price_cents as total cost (per-unit * size)
        // store placed_price_cents as per-unit price in cents (not multiplied by size)
        // store entry_price_cents as total cost (per-unit_with_fee * size)
        // store placed_price_cents as per-unit executed price including fee
        [userId, symbol, side, size, entryCost, typeof placedPriceCents === 'number' ? await applyFeeToPrice(placedPriceCents, symbol, client, side) : null, stop_loss_cents, take_profit_cents, order_type]
      );
      const position = posRes.rows[0];

      // 2) charge user: deduct total cost from wallet
      const entryAmount = entryCost;
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
        [userId, null, -entryAmount, balanceBefore.toString(), balanceAfter.toString(), 'position_open', JSON.stringify({ position_id: position.id, symbol, entry_cost_cents: entryAmount })]
      );

      // position opened
      // notify the owner that positions changed
      try { notifyUser(userId, 'positions:changed', { positionId: position.id, action: 'open' }); } catch (e) {}
      return { ok: true, positionId: position.id };
    }

    // Decide execution for market orders or immediate limit fills
    // Normalize symbol: uppercase and use exchange symbol (BTCUSDT not BTCUSD) so ticks match
    symbol = (symbol || 'BTCUSD').toUpperCase();
    if (symbol.endsWith('USD') && !symbol.endsWith('USDT')) symbol = symbol.replace(/USD$/, 'USDT');
    const lastPrice = await getLastPrice();
    // Broker order placement disabled: execute locally within platform using last known price or pending logic
    if (order_type === 'market') {
      // choose execution price: prefer raw ask for buy, raw bid for sell from Redis tick, fallback to lastPrice
      let execPerUnit = lastPrice;
      try {
        const raw = await redis.get(`tick_latest:${symbol}`);
        if (raw) {
          const tick = JSON.parse(raw);
          if (tick) {
            if (side === 'buy' && typeof tick.raw_ask_cents === 'number') execPerUnit = tick.raw_ask_cents;
            else if (side === 'sell' && typeof tick.raw_bid_cents === 'number') execPerUnit = tick.raw_bid_cents;
            else if (side === 'buy' && typeof tick.ask_cents === 'number') execPerUnit = tick.ask_cents;
            else if (side === 'sell' && typeof tick.bid_cents === 'number') execPerUnit = tick.bid_cents;
            else if (typeof tick.price_cents === 'number') execPerUnit = tick.price_cents;
          }
        }
      } catch (err) {
        console.warn('redis tick read failed', err);
      }
      if (!execPerUnit) {
        await client.query('ROLLBACK');
        return { error: 'no_price_available' };
      }
      const res = await openPosition(execPerUnit, execPerUnit);
      if (res.error) return res;
      await client.query('COMMIT');
      return res;
    } else {
      // Limit order: user sets price P. We store P and only activate when market allows us to fill at P after our fee (see pendingActivator).
      const sizeNum = Number(size || 0);
      const userPrice = Number(price_cents || 0);

      const internalTrigger = await getInternalTriggerPrice(userPrice, symbol, client, side);
      if (internalTrigger <= 0) {
        await client.query('ROLLBACK');
        return { error: 'invalid_limit_price_after_fee' };
      }

      const entryCost = Math.ceil(userPrice * sizeNum);

      // 1) create pending position record
      // Store user's requested price in placed_price_cents
      const pendingRes = await client.query(
        `INSERT INTO positions (user_id, symbol, side, size, entry_price_cents, placed_price_cents, stop_loss_cents, take_profit_cents, order_type, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW()) RETURNING *`,
        [userId, symbol, side, size, entryCost, userPrice, stop_loss_cents, take_profit_cents, order_type]
      );
      const position = pendingRes.rows[0];

      // 2) charge user (freeze funds)
      const wq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [userId]);
      const balance = BigInt(wq.rows[0]?.balance_cents || 0);
      const cost = BigInt(entryCost);
      if (balance < cost) {
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
        [userId, null, -entryCost, balanceBefore.toString(), balanceAfter.toString(), 'position_hold', JSON.stringify({ position_id: position.id, symbol, entry_cost_cents: entryCost })]
      );

      await client.query('COMMIT');
      return { ok: true, pending: true, positionId: position.id };
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

    // Handle pending position cancellation (release frozen funds)
    if (pos.status === 'pending') {
      const entryAmount = BigInt(Number(pos.entry_price_cents || 0));
      const wq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [pos.user_id]);
      const before = BigInt(wq.rows[0]?.balance_cents || 0);
      const after = before + entryAmount;
      await client.query('UPDATE wallets SET balance_cents=$1 WHERE user_id=$2', [after.toString(), pos.user_id]);

      await client.query(
        `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [pos.user_id, null, Number(entryAmount), before.toString(), after.toString(), 'position_release', JSON.stringify({ position_id: pos.id, symbol: pos.symbol, released_cents: Number(entryAmount) })]
      );

      await client.query('UPDATE positions SET status=$1, closed_at=NOW() WHERE id=$2', ['cancelled', pos.id]);
      await client.query('COMMIT');
      return { ok: true, positionId: pos.id, status: 'cancelled' };
    }

    if (pos.status !== 'open') {
      await client.query('ROLLBACK');
      return { error: 'position_not_open' };
    }

    // determine close price
    let closePrice = closePriceCents;
    // whether the tick we read from redis already has fee applied
    let tickHasFee = false;
    if (closePrice === null || closePrice === undefined) {
      // Prefer Redis latest tick (real-time) to match socket feed; fallback to trades table
      try {
        const raw = await redis.get(`tick_latest:${pos.symbol}`);
        if (raw) {
          const tick = JSON.parse(raw);
          if (tick) {
            tickHasFee = !!tick.fee_applied;
            // For closing: use ask to close a buy (sell into ask), use bid to close a sell (buy from bid)
            if (pos.side === 'buy' && typeof tick.ask_cents === 'number') closePrice = tick.ask_cents;
            if (pos.side === 'sell' && typeof tick.bid_cents === 'number') closePrice = tick.bid_cents;
            // fallback to mid price if no side-specific price available
            if ((closePrice === null || closePrice === undefined) && typeof tick.bid_cents === 'number' && typeof tick.ask_cents === 'number') {
              closePrice = Math.round((tick.bid_cents + tick.ask_cents) / 2);
            }
            // keep backwards compatibility if a legacy price_cents was stored
            if ((closePrice === null || closePrice === undefined) && typeof tick.price_cents === 'number') {
              closePrice = tick.price_cents;
            }
          }
        }
      } catch (err) {
        console.warn('redis tick read failed', err);
      }

      if (closePrice === null || closePrice === undefined) {
        const lp = await client.query('SELECT price_cents FROM trades WHERE symbol=$1 ORDER BY executed_at DESC LIMIT 1', [pos.symbol]);
        if (lp.rowCount) {
          closePrice = lp.rows[0].price_cents;
        }
      }

      if (!closePrice && closePrice !== 0) {
        await client.query('ROLLBACK');
        return { error: 'no_price_available' };
      }
    }

    // pos.entry_price_cents is stored as total cost (per-unit_with_fee * size)
    const entryAmount = BigInt(Number(pos.entry_price_cents || 0));
    const sizeNum = Number(pos.size);
    // if tick already has fees applied (broadcasted), don't re-apply
    let closePriceWithFee;
    if (typeof closePrice === 'number' && tickHasFee) {
      closePriceWithFee = Number(closePrice);
    } else {
      const closeDirection = pos.side === 'buy' ? 'sell' : 'buy';
      closePriceWithFee = await applyFeeToPrice(Number(closePrice), pos.symbol, client, closeDirection);
    }
    const closeAmount = BigInt(Math.ceil(closePriceWithFee * sizeNum));
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
      // record close_amount (total credited) and meta with per-unit close price including fee
      [pos.user_id, null, Number(closeAmount), before.toString(), after.toString(), 'position_close', JSON.stringify({ position_id: pos.id, close_price_cents: closePriceWithFee })]
    );

    // update position
    await client.query('UPDATE positions SET status=$1, closed_at=NOW(), close_price_cents=$2, realized_pnl_cents=$3 WHERE id=$4', ['closed', closePriceWithFee, Number(pnl), pos.id]);

    // insert a trade record for the close (no counterparty)
    await client.query(
      `INSERT INTO trades (buy_order_id, sell_order_id, price_cents, size, executed_at, symbol)
       VALUES ($1,$2,$3,$4,NOW(),$5)`,
      // store trade price as per-unit including fee
      [null, null, closePriceWithFee, sizeNum, pos.symbol]
    );

    await client.query('COMMIT');
    try { notifyUser(pos.user_id, 'positions:changed', { positionId: pos.id, action: 'close', pnl: Number(pnl) }); } catch (e) {}
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

module.exports = { 
  placeOrder: placeOrderCompat, 
  closePosition,
  activatePendingPosition,
  getInternalTriggerPrice
};

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

    // if marketPriceCents not provided, try to get latest tick from redis
    let execPrice = marketPriceCents;
    // execPriceIsFeeAdjusted indicates whether execPrice already includes fees
    let execPriceIsFeeAdjusted = false;
    if (!execPrice) {
      try {
        const raw = await redis.get(`tick_latest:${pos.symbol}`);
        if (raw) {
          const tick = JSON.parse(raw);
          if (tick && typeof tick.price_cents === 'number') {
            execPrice = tick.price_cents;
            execPriceIsFeeAdjusted = false;
          }
        }
      } catch (err) {
        console.warn('redis tick read failed', err);
      }
    } else {
      // when caller provided a marketPriceCents, assume it's raw tick (not fee adjusted)
      execPriceIsFeeAdjusted = false;
    }

    // pos.entry_price_cents stored as total cost for pending positions as well
    const storedEntry = Number(pos.entry_price_cents || 0);
    const perUnitEntry = storedEntry && Number(pos.size) ? storedEntry / Number(pos.size) : Number(pos.entry_price_cents || 0);
    if (!execPrice) {
      execPrice = perUnitEntry;
      execPriceIsFeeAdjusted = true; // stored entry came from DB and already includes fees
    }
    const sizeNum = Number(pos.size);
    // compute fee-inclusive per-unit and total entry amount
    let execPriceWithFee;
    if (pos.order_type === 'limit') {
      // For limit orders, user pays their requested price (stored in placed_price_cents)
      execPriceWithFee = Number(pos.placed_price_cents);
    } else {
      execPriceWithFee = execPriceIsFeeAdjusted ? Number(execPrice) : await applyFeeToPrice(Number(execPrice), pos.symbol, client, pos.side);
    }
    const entryAmount = BigInt(Math.ceil(execPriceWithFee * sizeNum));

    // Funds were already frozen during placeOrder for limit orders.
    // For limit orders, entryAmount should match storedEntry (userPrice * size), so diff will be 0.
    const frozenAmount = BigInt(storedEntry);
    const diff = frozenAmount - entryAmount;

    if (diff !== 0n) {
      const wq = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [pos.user_id]);
      const balance = BigInt(wq.rows[0]?.balance_cents || 0);
      const balanceAfter = balance + diff;
      await client.query('UPDATE wallets SET balance_cents=$1 WHERE user_id=$2', [balanceAfter.toString(), pos.user_id]);

      await client.query(
        `INSERT INTO ledger (user_id, related_order_id, change_cents, balance_before, balance_after, type, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [pos.user_id, null, Number(diff), balance.toString(), balanceAfter.toString(), 'position_adjustment', JSON.stringify({ position_id: pos.id, symbol: pos.symbol, adjustment_cents: Number(diff) })]
      );
    }

    // update position to open and set actual entry price (store total cost)
    // also set placed_price_cents to the per-unit execution price (fee-inclusive)
    await client.query('UPDATE positions SET status=$1, entry_price_cents=$2, placed_price_cents=$3, created_at=NOW() WHERE id=$4', ['open', Number(entryAmount), execPriceWithFee, pos.id]);

    // record a trade for the open (no counterparty)
    await client.query(
      `INSERT INTO trades (buy_order_id, sell_order_id, price_cents, size, executed_at, symbol)
       VALUES ($1,$2,$3,$4,NOW(),$5)`,
      // store trade price as per-unit including fee
      [null, null, execPriceWithFee, sizeNum, pos.symbol]
    );

    await client.query('COMMIT');
    // notify user that their pending position was activated
    try { notifyUser(pos.user_id, 'positions:changed', { positionId: pos.id, action: 'activate' }); } catch (e) {}
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