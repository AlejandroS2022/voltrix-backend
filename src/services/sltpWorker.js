const Redis = require('ioredis');
const redis = require('../config/redis');
const { getDb } = require('../db');
const { closePosition } = require('./matchingEngine');

const SUB_CHANNEL = 'market:prices';

const feeCache = new Map();
const CACHE_TTL = 30000;

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
    console.error('Failed to fetch fee for sltpWorker', symbol, err);
    return null;
  }
}

async function handleTick(tick) {
  // tick: may include raw_bid_cents and raw_ask_cents (bookTicker)
  if (!tick || !tick.symbol) return;
  const symbol = tick.symbol;
  const symbolUpper = symbol.toUpperCase();
  const rawBid = tick.raw_bid_cents || tick.bid_cents || null;
  const rawAsk = tick.raw_ask_cents || tick.ask_cents || null;
  if (rawBid === null || rawAsk === null) return;
  const db = getDb();
  
  const fee = await getFeeForSymbol(symbolUpper, db);

  // Find open positions with SL/TP that should trigger at this price
  // For long positions (side=buy): SL triggers when market price <= stop_loss; TP triggers when market price >= take_profit
  // For short positions (side=sell): SL triggers when market price >= stop_loss; TP triggers when market price <= take_profit
  const symbolsToMatch = symbolUpper.endsWith('USDT') ? [symbolUpper, symbolUpper.replace(/USDT$/, 'USD')] : [symbolUpper];
  const placeholders = symbolsToMatch.map((_, i) => `$${i + 1}`).join(',');

  const q = `
    SELECT id, user_id, side, size, placed_price_cents, stop_loss_cents, take_profit_cents
    FROM positions
    WHERE UPPER(symbol) IN (${placeholders}) AND status='open' AND (stop_loss_cents IS NOT NULL OR take_profit_cents IS NOT NULL)
  `;
  let rows;
  try {
    const res = await db.query(q, symbolsToMatch);
    rows = res.rows;
  } catch (err) {
    console.error('SLTP worker DB error', err);
    return;
  }

    for (const o of rows) {
    try {
      const placedPrice = o.placed_price_cents ? Number(o.placed_price_cents) : null;
      const sl = o.stop_loss_cents ? Number(o.stop_loss_cents) : null;
      const tp = o.take_profit_cents ? Number(o.take_profit_cents) : null;
      
      let feeCentsPercent = 0;
      let feeCentsFixed = 0;
      if (fee) {
        if (fee.fee_type === 'percent') {
          feeCentsPercent = parseFloat(fee.fee_value) || 0;
        } else {
          feeCentsFixed = Math.round((parseFloat(fee.fee_value) || 0) * 100);
        }
      }

      let triggered = null; // 'sl' or 'tp'

      if (o.side === 'buy') {
        // for buy positions, check the bid price (what we'd get when selling) minus the closing fee
        let effectiveClosePrice = rawBid;
        if (feeCentsPercent) effectiveClosePrice = Math.round(rawBid * (1 - feeCentsPercent / 100));
        else effectiveClosePrice -= feeCentsFixed;

        if (sl !== null && effectiveClosePrice <= (placedPrice - sl)) triggered = 'sl';
        if (tp !== null && effectiveClosePrice >= (placedPrice + tp)) triggered = 'tp';
      } else {
        // for sell positions, check the ask price (what we'd pay to buy back) plus the closing fee
        let effectiveClosePrice = rawAsk;
        if (feeCentsPercent) effectiveClosePrice = Math.round(rawAsk * (1 + feeCentsPercent / 100));
        else effectiveClosePrice += feeCentsFixed;

        if (sl !== null && effectiveClosePrice >= (placedPrice + sl)) triggered = 'sl';
        if (tp !== null && effectiveClosePrice <= (placedPrice - tp)) triggered = 'tp';
      }

      if (!triggered) continue;

      // Close the open position atomically
      try {
        // Let matchingEngine pick the appropriate close price from redis (it will prefer ask for buy, bid for sell)
        const res = await closePosition({ positionId: o.id });
        if (res && res.ok) {
          console.log(`Position ${o.id} closed by ${triggered} (${symbol}), pnl=${res.pnl}`);
        } else {
          console.warn(`Position ${o.id} SL/TP close attempted but failed`, res);
        }
      } catch (err) {
        console.error('Failed to close position for SL/TP', o.id, err);
      }
    } catch (err) {
      console.error('Failed to process SL/TP for order', o.id, err);
    }
  }
}

function startSlTpWorker() {
  const sub = new Redis(process.env.REDIS_URL);
  sub.on('connect', () => console.log('SL/TP worker connected to Redis'));
  sub.on('error', (err) => console.error('SL/TP worker redis error', err));
  sub.subscribe(SUB_CHANNEL, (err) => {
    if (err) return console.error('SL/TP subscribe error', err);
    console.log('SL/TP worker subscribed to', SUB_CHANNEL);
  });
  sub.on('message', (_chan, message) => {
    try {
      const data = JSON.parse(message);
      handleTick(data).catch(e => console.error('SLTP handleTick error', e));
    } catch (err) {
      console.error('Invalid tick message for SL/TP worker', err);
    }
  });
}

module.exports = { startSlTpWorker };
