const Redis = require('ioredis');
const redis = require('../config/redis');
const { getDb } = require('../db');
const { closePosition } = require('./matchingEngine');

const SUB_CHANNEL = 'market:prices';

async function handleTick(tick) {
  // tick: { symbol, price_cents, size, ts }
  if (!tick || !tick.symbol || !tick.price_cents) return;
  const price = Number(tick.price_cents);
  const symbol = tick.symbol;
  const db = getDb();

  // Find open positions with SL/TP that should trigger at this price
  // For long positions (side=buy): SL triggers when market price <= stop_loss; TP triggers when market price >= take_profit
  // For short positions (side=sell): SL triggers when market price >= stop_loss; TP triggers when market price <= take_profit
  const q = `
    SELECT id, user_id, side, size, stop_loss_cents, take_profit_cents
    FROM positions
    WHERE symbol=$1 AND status='open' AND (stop_loss_cents IS NOT NULL OR take_profit_cents IS NOT NULL)
  `;
  let rows;
  try {
    const res = await db.query(q, [symbol]);
    rows = res.rows;
  } catch (err) {
    console.error('SLTP worker DB error', err);
    return;
  }

    for (const o of rows) {
    try {
      const sl = o.stop_loss_cents ? Number(o.stop_loss_cents) : null;
      const tp = o.take_profit_cents ? Number(o.take_profit_cents) : null;
      let triggered = null; // 'sl' or 'tp'

      if (o.side === 'buy') {
        if (sl !== null && price <= sl) triggered = 'sl';
        if (tp !== null && price >= tp) triggered = 'tp';
      } else {
        if (sl !== null && price >= sl) triggered = 'sl';
        if (tp !== null && price <= tp) triggered = 'tp';
      }

      if (!triggered) continue;

      // Close the open position atomically
      try {
        const res = await closePosition({ positionId: o.id, closePriceCents: price });
        if (res && res.ok) {
          console.log(`Position ${o.id} closed by ${triggered} at price ${price} (${symbol}), pnl=${res.pnl}`);
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
