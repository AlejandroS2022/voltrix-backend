const WebSocket = require('ws');
const EventEmitter = require('events');
const redis = require('../config/redis');

const EMIT_CHANNEL = 'market:prices';
const BINANCE_FUTURES_WS = 'wss://stream.binance.com/stream';

class BinanceAdapter extends EventEmitter {
  constructor({ apiKey, apiSecret, testnet = false } = {}) {
    super();
    this.apiKey = apiKey || process.env.BINANCE_API_KEY;
    this.apiSecret = apiSecret || process.env.BINANCE_API_SECRET;
    this.testnet = testnet || process.env.BINANCE_TESTNET === 'true';
    this.enabled = process.env.BINANCE_ENABLE === 'true' || Boolean(this.apiKey);
    this.ws = null;
    this.subscribed = [];
  }

  // Starts only market data websocket and publishes ticks to Redis + emits 'tick' events.
  startMarketData(symbols = ['BTCUSDT']) {
    // always start market data even if no API key — public feed
    const streams = symbols.map(s => `${s.toLowerCase()}@trade`).join('/');
    const url = `${BINANCE_FUTURES_WS}?streams=${streams}`;
    this.ws = new WebSocket(url);
    this.ws.on('open', () => console.log('Binance market websocket connected'));
    this.ws.on('error', (e) => console.error('Binance WS error', e));
    this.ws.on('close', () => console.log('Binance WS closed'));
    this.ws.on('message', (msg) => {
      try {
        const p = JSON.parse(msg);
        const data = p.data || p;
        const tick = {
          symbol: (data.s || '').toUpperCase(),
          price_cents: Math.round(parseFloat(data.p) * 100),
          size: parseFloat(data.q) || 0,
          ts: data.T || Date.now()
        };
        try { redis.publish(EMIT_CHANNEL, JSON.stringify(tick)); } catch (e) { /* ignore */ }
        try { redis.set(`tick_latest:${tick.symbol}`, JSON.stringify(tick)); } catch (e) { /* ignore */ }
        this.emit('tick', tick);
      } catch (err) {
        console.error('Failed to parse binance ws msg', err);
      }
    });
  }

  // Broker order placement & user-data stream are intentionally disabled in this deployment.
  async placeOrder() {
    return { ok: false, error: 'broker_order_placement_disabled' };
  }

  async cancelOrder() {
    return { ok: false, error: 'broker_order_placement_disabled' };
  }
}

module.exports = BinanceAdapter;
