const Redis = require('ioredis');
const redisUrl = process.env.REDIS_URL;
const subscriber = new Redis(redisUrl);
const { broadcastPrice } = require('../socket');
const { processTick } = require('./candleAggregator');
const { getDb } = require('../db');

// simple in-memory fee cache to avoid DB hits on every tick
const feeCache = new Map();

async function getFeeForSymbol(symbol) {
  if (!symbol) return null;
  const key = symbol.toUpperCase();
  if (feeCache.has(key)) return feeCache.get(key);
  try {
    const db = getDb();
    const q = await db.query('SELECT fee_type, fee_value FROM symbol_fees WHERE symbol=$1 LIMIT 1', [key]);
    if (q.rowCount === 0) {
      feeCache.set(key, null);
      return null;
    }
    const row = q.rows[0];
    feeCache.set(key, row);
    return row;
  } catch (err) {
    console.error('Failed to load fee for symbol', symbol, err);
    return null;
  }
}

function startPriceStream() {
  subscriber.on('connect', () => console.log('Price subscriber connected to Redis'));
  subscriber.on('error', (err) => console.error('Price subscriber error', err));

  // subscribe to a single channel 'market:prices' - publishers should use this channel
  subscriber.subscribe('market:prices', (err, count) => {
    if (err) return console.error('Failed to subscribe to market:prices', err);
    console.log('Subscribed to market:prices channel');
  });

  subscriber.on('message', (channel, message) => {
    try {
      const parsed = JSON.parse(message);
      // expected { symbol, price_cents, size, ts }
      (async () => {
        try {
          const fee = await getFeeForSymbol(parsed.symbol);
          const enriched = Object.assign({}, parsed);
          if (fee) {
            enriched.fee_type = fee.fee_type;
            enriched.fee_value = fee.fee_value;
            // compute price_with_fee: percent increases price by percentage; fixed adds cents
            if (fee.fee_type === 'percent') {
              const pct = parseFloat(fee.fee_value) || 0;
              enriched.price_with_fee_cents = Math.round(parsed.price_cents * (1 + pct / 100));
            } else {
              const fixed = Math.round(parseFloat(fee.fee_value) || 0);
              enriched.price_with_fee_cents = parsed.price_cents + fixed;
            }
          }
          broadcastPrice(enriched);
          processTick(enriched).catch((e) => console.error('tick process error', e));
        } catch (err) {
          console.error('Failed to enrich tick', err);
        }
      })();
    } catch (err) {
      console.error('Invalid price message', err);
    }
  });
}

module.exports = { startPriceStream };
