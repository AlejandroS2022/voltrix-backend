const WebSocket = require('ws');
const EventEmitter = require('events');
const redis = require('../config/redis');
const { getDb } = require('../db');
const axios = require('axios');

const EMIT_CHANNEL = 'market:prices';
// Twelve Data WebSocket URL - try the time series endpoint for price updates
const getTwelveDataWsUrl = () => {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  // Try different endpoints - /time works for basic connections
  const baseUrls = [
    'wss://ws.twelvedata.com/v1/quotes/price',
    'wss://ws.twelvedata.com/v1',
  ];
  // Return first URL for now - could add fallback logic later
  const baseUrl = baseUrls[0];
  if (apiKey) {
    return `${baseUrl}?apikey=${apiKey}`;
  }
  return baseUrl;
};

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;

class TwelveDataAdapter extends EventEmitter {
  constructor({ apiKey } = {}) {
    super();
    this.apiKey = apiKey || process.env.TWELVEDATA_API_KEY;
    this.enabled = Boolean(this.apiKey);
    this.ws = null;
    this.subscribed = [];
    this.marketDataSymbols = [];
    this.reconnectTimeout = null;
    this.reconnectAttempt = 0;
    this.pingInterval = null;
    this.symbolsMap = new Map(); // Map Twelve Data symbols to internal format
    this.lastUpdateMap = new Map(); // Map td_symbol -> last update timestamp
    this.pollingInterval = null;
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

  _clearPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimeout) return;
    const delay = Math.min(
      RECONNECT_MIN_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt++;
    console.log(`Twelve Data WS: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.marketDataSymbols.length) {
        this.startMarketData(this.marketDataSymbols);
      }
    }, delay);
  }

  _disposeWs() {
    this._clearPing();
    this._clearPolling();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
    }
  }

  // Convert Twelve Data symbol format (BTC/USD) to internal format (BTCUSD)
  _toInternalSymbol(tdSymbol) {
    if (this.symbolsMap.has(tdSymbol)) {
      return this.symbolsMap.get(tdSymbol);
    }
    // BTC/USD -> BTCUSD, AAPL -> AAPL
    const internal = tdSymbol.replace('/', '');
    this.symbolsMap.set(tdSymbol, internal);
    return internal;
  }

  // Start market data websocket and publish ticks to Redis + emit 'tick' events
  async startMarketData(symbols = ['BTC/USD']) {
    if (!this.enabled) {
      console.log('Twelve Data adapter disabled - no API key configured');
      return;
    }

    this.marketDataSymbols = symbols;
    this._clearReconnect();
    this._disposeWs();

    // On initialization, fetch last price for all symbols and save to Redis if missing
    for (const symbol of symbols) {
      const internalSymbol = this._toInternalSymbol(symbol);
      try {
        const existing = await redis.get(`tick_latest:${internalSymbol}`);
        if (!existing) {
          // Fetch from Twelve Data REST API
          try {
            const apiKey = this.apiKey;
            const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}${apiKey ? `&apikey=${apiKey}` : ''}`;
            const resp = await axios.get(url, { timeout: 5000 });
            if (resp.data && resp.data.price) {
              const priceCents = parseFloat(resp.data.price) * 100;
              const now = Date.now();
              const tick = {
                symbol: internalSymbol,
                td_symbol: symbol,
                price_cents: priceCents,
                raw_bid_cents: priceCents,
                raw_ask_cents: priceCents,
                bid_cents: priceCents,
                ask_cents: priceCents,
                ts: now,
                fee_applied: false,
                source: 'twelvedata_rest'
              };
              await redis.set(`tick_latest:${internalSymbol}`, JSON.stringify(tick));
              console.log(`Seeded Redis price for ${internalSymbol} from REST API: ${priceCents / 100}`);
              this.lastUpdateMap.set(symbol, Date.now());
              // Immediately publish to market:prices so priceStream/socket emits to frontend
              try {
                await redis.publish(EMIT_CHANNEL, JSON.stringify(tick));
                console.log(`Published seeded tick for ${internalSymbol} to market:prices`);
              } catch (e) {
                console.warn('Failed to publish seeded tick for', internalSymbol, e);
              }
            }
          } catch (err) {
            console.warn('Twelve Data REST fallback failed for', symbol, err?.message || err);
          }
        } else {
          // Data was present in redis, mark updated now to prevent instant poll
          this.lastUpdateMap.set(symbol, Date.now());
        }
      } catch (e) {
        // ignore
      }
    }

    // Start fallback polling interval
    this._clearPolling();
    this.pollingInterval = setInterval(() => this._pollStaleSymbols(), 30000); // Check every 30s

    // Build subscription message for Twelve Data WebSocket
    // Format: { "action": "subscribe", "params": { "symbols": "AAPL,TRP,QQQ,EUR/USD" } }
    const subscribeMsg = {
      action: 'subscribe',
      params: {
        symbols: symbols.join(','),
      },
    };

    this.ws = new WebSocket(getTwelveDataWsUrl());

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      console.log('Twelve Data market websocket connected');

      // Subscribe to symbols
      this.ws.send(JSON.stringify(subscribeMsg));
      console.log('Twelve Data: sent subscribe for', symbols);
      this.subscribed = [...symbols];

      this._clearPing();
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, PING_INTERVAL_MS);
    });

    this.ws.on('error', (e) => {
      console.error('Twelve Data WS error', e.message || e);
      this._scheduleReconnect();
    });

    this.ws.on('close', () => {
      console.log('Twelve Data WS closed');
      this._disposeWs();
      this._scheduleReconnect();
    });

    this.ws.on('message', (msg) => {
      (async () => {
        try {
          const data = JSON.parse(msg);

          // Handle subscription status response
          if (data.event === 'subscribe-status') {
            if (data.status === 'error') {
              console.error('Twelve Data subscription error:', data.fails);
            } else {
              console.log('Twelve Data subscription status:', data.status,
                'success:', (data.success || []).map(s => s.symbol).join(','),
                'fails:', (data.fails || []).map(s => s.symbol).join(','));
            }
            return;
          }

          // Handle error messages
          if (data.code) {
            console.error('Twelve Data error:', data.message, data.code);
            return;
          }
          if (data.status === 'error') {
            console.error('Twelve Data error:', data.message);
            return;
          }

          // Handle price update
          // Twelve Data sends: { event: "price", symbol: "BTC/USD", price: 67140.17, timestamp: 1771436820 }
          // Note: timestamp is Unix seconds (not ms), and there is no bid/ask — only price
          if (data.event && data.event !== 'price') {
            // Unknown event type, skip
            return;
          }

          const symbol = data.symbol;
          if (!symbol) return;

          this.lastUpdateMap.set(symbol, Date.now());
          const internalSymbol = this._toInternalSymbol(symbol);

          // Parse price - Twelve Data sends prices as floats
          // No bid/ask available from free tier — synthesize from price
          const rawPrice = data.price !== undefined && data.price !== null ? parseFloat(data.price) * 100 : null;

          // Only allow saving to Redis if price is present, or if this is the first tick for this symbol
          let shouldSave = false;
          let fallbackPrice = null;
          if (rawPrice !== null) {
            shouldSave = true;
          } else {
            // Check if Redis already has a value for this symbol
            try {
              const existing = await redis.get(`tick_latest:${internalSymbol}`);
              if (!existing) {
                // Try to fetch last price from Twelve Data REST API as fallback
                try {
                  const apiKey = this.apiKey;
                  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}${apiKey ? `&apikey=${apiKey}` : ''}`;
                  const resp = await axios.get(url, { timeout: 5000 });
                  if (resp.data && resp.data.price) {
                    fallbackPrice = Math.round(parseFloat(resp.data.price) * 100);
                    shouldSave = true;
                  }
                } catch (err) {
                  console.warn('Twelve Data REST fallback failed for', symbol, err?.message || err);
                }
              }
            } catch (e) {
              shouldSave = false;
            }
          }
          if (!shouldSave) return;

          // Twelve Data timestamp is Unix seconds, convert to ms
          const ts = data.timestamp ? data.timestamp * 1000 : Date.now();

          // Since Twelve Data doesn't provide bid/ask, use price as both
          // Fee will be applied below to create spread
          const finalPrice = rawPrice !== null ? rawPrice : fallbackPrice;
          const rawBid = finalPrice;
          const rawAsk = finalPrice;

          // Fetch fee for symbol from DB
          let fee = null;
          try {
            const db = getDb();
            const fq = await db.query('SELECT fee_type, fee_value FROM symbol_fees WHERE symbol=$1 LIMIT 1', [internalSymbol]);
            if (fq.rowCount) fee = fq.rows[0];
          } catch (e) {
            console.warn('failed to load symbol fee for broadcast', internalSymbol, e);
          }

          // Compute fee-adjusted bid/ask
          let adjAsk = rawAsk;
          let adjBid = rawBid;
          if (fee && (rawAsk !== null || rawBid !== null)) {
            if (fee.fee_type === "percent") {
              const pct = parseFloat(fee.fee_value) || 0;
              adjAsk = rawAsk * (1 + pct / 100);
              adjBid = rawBid * (1 - pct / 100);
            } else {
              const fixed = (parseFloat(fee.fee_value) || 0) * 100;
              adjAsk = rawAsk + fixed;
              adjBid = Math.max(0, rawBid - fixed);
            }
          }

          const tick = {
            symbol: internalSymbol,
            // Original symbol from Twelve Data for reference
            td_symbol: symbol,
            price_cents: rawPrice || rawBid || rawAsk,
            raw_bid_cents: rawBid,
            raw_ask_cents: rawAsk,
            bid_cents: adjBid,
            ask_cents: adjAsk,
            ts,
            fee_applied: !!fee,
            source: 'twelvedata'
          };

          try { redis.publish(EMIT_CHANNEL, JSON.stringify(tick)); } catch (e) { /* ignore */ }
          try { redis.set(`tick_latest:${internalSymbol}`, JSON.stringify(tick)); } catch (e) { /* ignore */ }

          // Emit locally
          this.emit('tick', tick);
        } catch (err) {
          console.error('Failed to parse Twelve Data ws msg', err);
        }
      })();
    });
  }

  async _pollStaleSymbols() {
    if (!this.enabled || !this.marketDataSymbols.length) return;
    
    const now = Date.now();
    const STALE_THRESHOLD_MS = 60000; // 60 seconds
    const staleSymbols = [];

    for (const symbol of this.marketDataSymbols) {
      const lastUs = this.lastUpdateMap.get(symbol) || 0;
      if (now - lastUs > STALE_THRESHOLD_MS) {
        staleSymbols.push(symbol);
      }
    }

    if (staleSymbols.length === 0) return;
    // To prevent API spam, grab up to 50 stale symbols at a time
    const batchTargets = staleSymbols.slice(0, 50);

    const BATCH_SIZE = 10;
    for (let i = 0; i < batchTargets.length; i += BATCH_SIZE) {
      const batch = batchTargets.slice(i, i + BATCH_SIZE);
      try {
        const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(batch.join(','))}${this.apiKey ? `&apikey=${this.apiKey}` : ''}`;
        const resp = await axios.get(url, { timeout: 10000 });
        
        if (resp.data) {
          const processPriceUpdate = async (tdSymbol, priceObj) => {
            if (!priceObj || !priceObj.price) return;
            const priceCents = parseFloat(priceObj.price) * 100;
            const internalSymbol = this._toInternalSymbol(tdSymbol);
            this.lastUpdateMap.set(tdSymbol, Date.now());

            let fee = null;
            try {
              const db = getDb();
              const fq = await db.query('SELECT fee_type, fee_value FROM symbol_fees WHERE symbol=$1 LIMIT 1', [internalSymbol]);
              if (fq.rowCount) fee = fq.rows[0];
            } catch (e) {
              console.warn('failed to load symbol fee for broadcast', internalSymbol, e);
            }

            let adjAsk = priceCents;
            let adjBid = priceCents;
            if (fee) {
              if (fee.fee_type === "percent") {
                const pct = parseFloat(fee.fee_value) || 0;
                adjAsk = priceCents * (1 + pct / 100);
                adjBid = priceCents * (1 - pct / 100);
              } else {
                const fixed = (parseFloat(fee.fee_value) || 0) * 100;
                adjAsk = priceCents + fixed;
                adjBid = Math.max(0, priceCents - fixed);
              }
            }

            const tick = {
              symbol: internalSymbol,
              td_symbol: tdSymbol,
              price_cents: priceCents,
              raw_bid_cents: priceCents,
              raw_ask_cents: priceCents,
              bid_cents: adjBid,
              ask_cents: adjAsk,
              ts: Date.now(),
              fee_applied: !!fee,
              source: 'twelvedata_rest_polling'
            };

            try { redis.publish(EMIT_CHANNEL, JSON.stringify(tick)); } catch (e) { /* ignore */ }
            try { redis.set(`tick_latest:${internalSymbol}`, JSON.stringify(tick)); } catch (e) { /* ignore */ }
            this.emit('tick', tick);
          };

          if (batch.length === 1) {
            if (resp.data.price) {
              await processPriceUpdate(batch[0], resp.data);
            } else if (resp.data[batch[0]]) {
              await processPriceUpdate(batch[0], resp.data[batch[0]]);
            }
          } else {
            for (const sym of batch) {
              if (resp.data[sym]) {
                await processPriceUpdate(sym, resp.data[sym]);
              }
            }
          }
        }
      } catch (err) {
        console.error('Twelve Data polling error for batch', batch, err?.message || err);
      }
    }
  }

  // Subscribe to additional symbols
  subscribeToSymbols(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Cannot subscribe - WebSocket not connected');
      return;
    }

    const newSymbols = symbols.filter(s => !this.subscribed.includes(s));
    if (newSymbols.length === 0) return;

    const subscribeMsg = {
      action: 'subscribe',
      symbol: newSymbols,
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    this.subscribed = [...this.subscribed, ...newSymbols];
    this.marketDataSymbols = [...this.marketDataSymbols, ...newSymbols];
    console.log('Twelve Data: subscribed to', newSymbols);
  }

  // Unsubscribe from symbols
  unsubscribeFromSymbols(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Cannot unsubscribe - WebSocket not connected');
      return;
    }

    const subscribeMsg = {
      action: 'unsubscribe',
      symbol: symbols,
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    this.subscribed = this.subscribed.filter(s => !symbols.includes(s));
    this.marketDataSymbols = this.marketDataSymbols.filter(s => !symbols.includes(s));
    console.log('Twelve Data: unsubscribed from', symbols);
  }

  // Placeholder methods for compatibility
  async placeOrder() {
    return { ok: false, error: 'order_placement_not_supported' };
  }

  async cancelOrder() {
    return { ok: false, error: 'order_placement_not_supported' };
  }
}

module.exports = TwelveDataAdapter;
