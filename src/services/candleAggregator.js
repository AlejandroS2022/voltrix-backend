const redis = require('../config/redis');
const { broadcastCandle } = require('../socket');

// Supported resolutions in minutes (TradingView often uses strings like '1','5','15','60','D')
const RESOLUTIONS = { '1': 60, '5': 300, '15': 900, '60': 3600, 'D': 86400 };
const LIST_LIMIT = 2000;

// In-memory current candles per symbol+resolution
const currentCandles = new Map();

function _candleKey(symbol, resolution) {
  return `${symbol}:${resolution}`;
}

function _intervalStart(tsSeconds, resolutionSec) {
  return Math.floor(tsSeconds / resolutionSec) * resolutionSec;
}

async function processTick({ symbol, price_cents, size = 0, ts = null }) {
  if (!symbol || !price_cents) return;
  const tsSeconds = ts ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000);

  for (const [res, sec] of Object.entries(RESOLUTIONS)) {
    const start = _intervalStart(tsSeconds, sec);
    const key = _candleKey(symbol, res);
    const mapKey = `${key}:${start}`;

    let candle = currentCandles.get(mapKey);
    if (!candle) {
      // create new candle
      candle = {
        symbol,
        resolution: res,
        t: start,
        o: price_cents,
        h: price_cents,
        l: price_cents,
        c: price_cents,
        v: Number(size || 0)
      };
      currentCandles.set(mapKey, candle);
    } else {
      // update
      candle.h = Math.max(candle.h, price_cents);
      candle.l = Math.min(candle.l, price_cents);
      candle.c = price_cents;
      candle.v = candle.v + Number(size || 0);
    }

    // store in redis list as JSON under key 'candles:{symbol}:{res}'
    const redisList = `candles:${symbol}:${res}`;
    // store only when candle has a reasonable timestamp (we will store/update latest entry)
    // push only when interval completed (to keep writes low) - but also keep a latest value
    const latestField = `${start}`;
    // We'll maintain a Redis hash with latest candle and also an append list for history
    const latestKey = `candles_latest:${symbol}:${res}`;
    await redis.hset(latestKey, latestField, JSON.stringify(candle));

    // Broadcast the live candle to sockets (clients can use this for live updates)
    broadcastCandle(candle);
  }
}

async function startAggregator() {
  // ensure redis connection
  if (!redis) throw new Error('Redis client missing');
  console.log('Candle aggregator ready');
}

async function getHistory(symbol, resolution, fromSec, toSec) {
  // read stored latest hash entries then filter by time window
  const res = resolution in RESOLUTIONS ? resolution : '1';
  const latestKey = `candles_latest:${symbol}:${res}`;
  const all = await redis.hgetall(latestKey);
  const candles = Object.values(all).map((s) => JSON.parse(s)).filter(c => c.t >= fromSec && c.t <= toSec);
  // sort by time asc
  candles.sort((a, b) => a.t - b.t);
  // convert to TradingView arrays
  if (!candles.length) return { s: 'no_data' };
  const t = candles.map(c => c.t);
  const o = candles.map(c => c.o);
  const h = candles.map(c => c.h);
  const l = candles.map(c => c.l);
  const c = candles.map(ca => ca.c);
  const v = candles.map(ca => ca.v);
  return { s: 'ok', t, o, h, l, c, v };
}

module.exports = { processTick, startAggregator, getHistory };
