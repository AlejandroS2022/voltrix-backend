const Redis = require('ioredis');
const { getDb } = require('../db');
const { activatePendingPosition } = require('./matchingEngine');

const SUB_CHANNEL = 'market:prices';

// Create subscriber using same connection logic as config/redis so we receive published ticks
function createSubscriberClient() {
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) return new Redis();
  if (/^redis:\/\//.test(REDIS_URL)) return new Redis(REDIS_URL);
  if (REDIS_URL.includes(':')) {
    const [host, portStr] = REDIS_URL.split(':');
    const port = parseInt(portStr, 10) || 6379;
    return new Redis({ host, port });
  }
  return new Redis({ host: REDIS_URL });
}

// Simple in-memory fee cache to avoid DB hits on every tick
const feeCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

async function getFeeForSymbol(symbol, db) {
  const now = Date.now();
  const cacheKey = symbol;
  if (feeCache.has(cacheKey)) {
    const cached = feeCache.get(cacheKey);
    if (now - cached.ts < CACHE_TTL) return cached.fee;
  }
  try {
    let feeQ = await db.query('SELECT fee_type, fee_value FROM symbol_fees WHERE symbol=$1 LIMIT 1', [symbol]);
    if (feeQ.rowCount === 0 && symbol.endsWith('USDT')) {
      const altSymbol = symbol.replace(/USDT$/, 'USD');
      feeQ = await db.query('SELECT fee_type, fee_value FROM symbol_fees WHERE symbol=$1 LIMIT 1', [altSymbol]);
    }
    const fee = feeQ.rowCount ? feeQ.rows[0] : null;
    feeCache.set(cacheKey, { fee, ts: now });
    return fee;
  } catch (err) {
    console.error('Failed to fetch fee for activator', symbol, err);
    return null;
  }
}

/*
 * Limit order activation (Forex / IQ Option style)
 * -----------------------------------------------
 * The platform is the counterparty: we fill the user at their limit price and hedge on the exchange.
 *
 * BUY LIMIT at price P (user wants to buy when market is at or below P):
 *   - We only execute when we can buy from the exchange (Binance) low enough to give the user P after our fee.
 *   - Internal trigger = P - fee. We activate when: Binance Ask <= trigger.
 *   - So: we buy at Ask, add our fee, and "sell" to the user at P (we keep the fee).
 *
 * SELL LIMIT at price P (user wants to sell when market is at or above P):
 *   - We only execute when we can sell to the exchange high enough that after our fee the user gets P.
 *   - Internal trigger = P + fee. We activate when: Binance Bid >= trigger.
 *   - So: we "buy" from the user at P, sell at Bid, and keep the fee.
 *
 * Fee: percentage (fee_value in %) or fixed (fee_value in dollars, converted to cents).
 * We compare against raw Binance bid/ask (no fee applied) because we decide when we can profitably fill.
 */
async function handleTick(tick) {
  if (!tick || !tick.symbol) return;
  const symbol = (tick.symbol || '').toUpperCase();
  
  const rawBid = tick.raw_bid_cents;
  const rawAsk = tick.raw_ask_cents;
  if (typeof rawBid !== 'number' || typeof rawAsk !== 'number') return;

  const db = getDb();
  const fee = await getFeeForSymbol(symbol, db);

  // Match both exchange symbol (BTCUSDT) and display symbol (BTCUSD) so positions created with either are found
  const symbolsToMatch = symbol.endsWith('USDT') ? [symbol, symbol.replace(/USDT$/, 'USD')] : [symbol];
  const placeholders = symbolsToMatch.map((_, i) => `$${i + 1}`).join(',');

  const q = `
    SELECT id, user_id, side, size, entry_price_cents, placed_price_cents, symbol
    FROM positions
    WHERE UPPER(symbol) IN (${placeholders}) AND status='pending' AND order_type='limit'
    ORDER BY created_at ASC
    LIMIT 50
  `;
  let rows;
  try {
    const res = await db.query(q, symbolsToMatch);
    rows = res.rows;
  } catch (err) {
    console.error('Pending activator DB error', err);
    return;
  }

  for (const p of rows) {
    try {
      const side = String(p.side || '').toLowerCase();
      const userPrice = Number(p.placed_price_cents || 0);
      if (userPrice <= 0) continue;

      // Trigger = user price minus fee (buy) or plus fee (sell). Fee in cents.
      let feeCents = 0;
      if (fee) {
        if (fee.fee_type === 'percent') {
          feeCents = Math.round(userPrice * (parseFloat(fee.fee_value) || 0) / 100);
        } else {
          feeCents = Math.round((parseFloat(fee.fee_value) || 0) * 100); // fee_value in dollars
        }
      }
      const triggerPrice = side === 'buy' ? userPrice - feeCents : userPrice + feeCents;

      if (triggerPrice <= 0) continue;

      const shouldActivate =
        (side === 'buy' && rawAsk <= triggerPrice) ||
        (side === 'sell' && rawBid >= triggerPrice);

      if (process.env.DEBUG_LIMIT_ACTIVATOR && rows.length > 0) {
        console.log('[LimitActivator]', symbol, 'pending=', rows.length, 'rawBid=', rawBid, 'rawAsk=', rawAsk, 'pos', p.id, side, 'userPrice=', userPrice, 'trigger=', triggerPrice, 'shouldActivate=', shouldActivate);
      }

      if (!shouldActivate) continue;

      // Activate position using matching engine helper
      // Pass the raw mid price for recording purposes
      const rawMid = Math.round((rawBid + rawAsk) / 2);
      const res = await activatePendingPosition({ positionId: p.id, marketPriceCents: rawMid });
      if (res && res.ok) {
        console.log(`Activated pending position ${p.id} at price ${rawMid} (${symbol})`);
      } else {
        console.warn(`Failed to activate pending position ${p.id}`, res);
      }
    } catch (err) {
      console.error('Failed to process pending position', p.id, err);
    }
  }
}

function startPendingActivator() {
  const sub = createSubscriberClient();
  sub.on('connect', () => console.log('Pending activator connected to Redis'));
  sub.on('error', (err) => console.error('Pending activator redis error', err));
  sub.subscribe(SUB_CHANNEL, (err) => {
    if (err) return console.error('Pending activator subscribe error', err);
    console.log('Pending activator subscribed to', SUB_CHANNEL);
  });
  sub.on('message', (_chan, message) => {
    try {
      const data = JSON.parse(message);
      handleTick(data).catch(e => console.error('PendingActivator handleTick error', e));
    } catch (err) {
      console.error('Invalid tick message for PendingActivator', err);
    }
  });
}

module.exports = { startPendingActivator };
