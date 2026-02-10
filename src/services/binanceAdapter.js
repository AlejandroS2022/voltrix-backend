const WebSocket = require('ws');
const EventEmitter = require('events');
const redis = require('../config/redis');
const { broadcastPrice } = require('../socket');
const { getDb } = require('../db');

const EMIT_CHANNEL = 'market:prices';
const BINANCE_WS = process.env.BINANCE_WS_URL || 'wss://stream.binance.com/stream';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;

class BinanceAdapter extends EventEmitter {
  constructor({ apiKey, apiSecret, testnet = false } = {}) {
    super();
    this.apiKey = apiKey || process.env.BINANCE_API_KEY;
    this.apiSecret = apiSecret || process.env.BINANCE_API_SECRET;
    this.testnet = testnet || process.env.BINANCE_TESTNET === 'true';
    this.enabled = process.env.BINANCE_ENABLE === 'true' || Boolean(this.apiKey);
    this.ws = null;
    this.subscribed = [];
    this.marketDataSymbols = [];
    this.reconnectTimeout = null;
    this.reconnectAttempt = 0;
    this.pingInterval = null;
  }

  _clearReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  _clearPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimeout) return;
    const delay = Math.min(
      RECONNECT_MIN_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt++;
    console.log(`Binance WS: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.marketDataSymbols.length) {
        this.startMarketData(this.marketDataSymbols);
      }
    }, delay);
  }

  _disposeWs() {
    this._clearPing();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
    }
  }

  // Starts only market data websocket and publishes ticks to Redis + emits 'tick' events.
  startMarketData(symbols = ['BTCUSDT']) {
    this.marketDataSymbols = symbols;
    this._clearReconnect();
    this._disposeWs();

    // always start market data even if no API key — public feed
    // subscribe to best bid/ask (bookTicker) for each symbol
    const streams = symbols.map(s => `${s.toLowerCase()}@bookTicker`).join('/');
    const url = `${BINANCE_WS}?streams=${streams}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      console.log('Binance market websocket connected');
      this._clearPing();
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, PING_INTERVAL_MS);
    });

    this.ws.on('error', (e) => {
      console.error('Binance WS error', e.message || e);
      this._scheduleReconnect();
    });

    this.ws.on('close', () => {
      console.log('Binance WS closed');
      this._disposeWs();
      this._scheduleReconnect();
    });

    this.ws.on('message', (msg) => {
      (async () => {
        try {
          const p = JSON.parse(msg);
          const data = p.data || p;
          // bookTicker payload contains best bid 'b' and best ask 'a'
          const symbol = (data.s || '').toUpperCase();
          const rawBid = data.b ? Math.round(parseFloat(data.b) * 100) : null;
          const rawAsk = data.a ? Math.round(parseFloat(data.a) * 100) : null;
          const ts = data.E || Date.now();

          // fetch fee for symbol from DB (no cache here; priceStream has its own cache)
          let fee = null;
          try {
            const db = getDb();
            const fq = await db.query('SELECT fee_type, fee_value FROM symbol_fees WHERE symbol=$1 LIMIT 1', [symbol]);
            if (fq.rowCount) fee = fq.rows[0];
          } catch (e) {
            console.warn('failed to load symbol fee for broadcast', symbol, e);
          }

          // compute fee-adjusted bid/ask: ask increases by fee, bid decreases by fee
          let adjAsk = rawAsk;
          let adjBid = rawBid;
          if (fee && (rawAsk !== null || rawBid !== null)) {
            if (fee.fee_type === 'percent') {
              const pct = parseFloat(fee.fee_value) || 0;
              if (rawAsk !== null) adjAsk = Math.round(rawAsk * (1 + pct / 100));
              if (rawBid !== null) adjBid = Math.round(rawBid * (1 - pct / 100));
            } else {
              const fixed = Math.round((parseFloat(fee.fee_value) || 0) * 100);
              if (rawAsk !== null) adjAsk = rawAsk + fixed;
              if (rawBid !== null) adjBid = Math.max(0, rawBid - fixed);
            }
          }

          const tick = {
            symbol,
            // expose raw values and adjusted values; frontend uses adjusted `ask_cents`/`bid_cents`
            price_cents: (rawBid !== null && rawAsk !== null) ? Math.round((rawBid + rawAsk) / 2) : (rawBid || rawAsk),
            raw_bid_cents: rawBid,
            raw_ask_cents: rawAsk,
            bid_cents: adjBid,
            ask_cents: adjAsk,
            ts,
            fee_applied: !!fee
          };

          try { redis.publish(EMIT_CHANNEL, JSON.stringify(tick)); } catch (e) { /* ignore */ }
          try { redis.set(`tick_latest:${symbol}`, JSON.stringify(tick)); } catch (e) { /* ignore */ }
          // emit locally
          this.emit('tick', tick);
        } catch (err) {
          console.error('Failed to parse binance ws msg', err);
        }
      })();
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
