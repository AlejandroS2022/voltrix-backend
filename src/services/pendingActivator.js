const Redis = require('ioredis');
const redis = require('../config/redis');
const { getDb } = require('../db');
const { activatePendingPosition } = require('./matchingEngine');

const SUB_CHANNEL = 'market:prices';

async function handleTick(tick) {
  if (!tick || !tick.symbol || !tick.price_cents) return;
  const price = Number(tick.price_cents);
  const symbol = (tick.symbol || '').toUpperCase();
  const db = getDb();

  // Find pending positions that can be activated by this tick
  // For buy pending: activate when market price <= entry_price
  // For sell pending: activate when market price >= entry_price
  const q = `
    SELECT id, user_id, side, size, entry_price_cents, symbol
    FROM positions
    WHERE UPPER(symbol)=$1 AND status='pending'
    ORDER BY created_at ASC
    LIMIT 50
  `;
  let rows;
  try {
    const res = await db.query(q, [symbol]);
    rows = res.rows;
  } catch (err) {
    console.error('Pending activator DB error', err);
    return;
  }

  for (const p of rows) {
    try {
      const entry = Number(p.entry_price_cents);
      let shouldActivate = false;
      if (p.side === 'buy' && price <= entry) shouldActivate = true;
      if (p.side === 'sell' && price >= entry) shouldActivate = true;
      if (!shouldActivate) continue;

      // Activate position using matching engine helper
      const res = await activatePendingPosition({ positionId: p.id, marketPriceCents: price });
      if (res && res.ok) {
        console.log(`Activated pending position ${p.id} at price ${price} (${symbol})`);
      } else {
        console.warn(`Failed to activate pending position ${p.id}`, res);
      }
    } catch (err) {
      console.error('Failed to process pending position', p.id, err);
    }
  }
}

function startPendingActivator() {
  const sub = new Redis(process.env.REDIS_URL);
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
