const express = require('express');
const router = express.Router();
const { getHistory } = require('../services/candleAggregator');
const { requireAuth } = require('../middleware/auth');
const { placeOrder } = require('../services/matchingEngine');

// Simple static symbol map — replace or extend with DB-backed catalog if available
const SYMBOLS = {
  'BTCUSD': {
    name: 'BTCUSD',
    ticker: 'BTCUSD',
    description: 'Bitcoin / US Dollar',
    session: '24x7',
    timezone: 'UTC',
    exchange: 'VOLTRIX',
    minmov: 1,
    pricescale: 100, // cents -> so 2 decimals
    has_intraday: true,
    supported_resolutions: ['1','5','15','60','D']
  }
};

router.get('/config', (_req, res) => {
  res.json({
    supports_search: true,
    supports_group_request: false,
    supported_resolutions: ['1','5','15','60','D'],
    supports_marks: false,
    supports_timescale_marks: false
  });
});

router.get('/symbols', (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol || !SYMBOLS[symbol]) return res.status(404).json({ error: 'Symbol not found' });
  const s = SYMBOLS[symbol];
  res.json({
    name: s.name,
    ticker: s.ticker,
    description: s.description,
    session: s.session,
    timezone: s.timezone,
    exchange: s.exchange,
    minmov: s.minmov,
    pricescale: s.pricescale,
    has_intraday: s.has_intraday,
    supported_resolutions: s.supported_resolutions
  });
});

router.get('/search', (req, res) => {
  const query = (req.query.query || '').toUpperCase();
  const results = Object.values(SYMBOLS)
    .filter(s => s.name.includes(query) || s.ticker.includes(query))
    .map(s => ({ symbol: s.ticker, full_name: s.name, description: s.description, exchange: s.exchange }));
  res.json(results);
});

// TradingView history endpoint: expects symbol, from, to, resolution
router.get('/history', async (req, res) => {
  try {
    const { symbol, from, to, resolution } = req.query;
    if (!symbol || !from || !to || !resolution) return res.status(400).json({ s: 'error', error: 'Missing parameters' });

    const fromSec = parseInt(from, 10);
    const toSec = parseInt(to, 10);
    const r = await getHistory(symbol, resolution, fromSec, toSec);
    res.json(r);
  } catch (err) {
    console.error('history error', err);
    res.status(500).json({ s: 'error', error: 'Server error' });
  }
});

router.get('/time', (_req, res) => {
  res.json({ time: Math.floor(Date.now() / 1000) });
});

// Place order from chart UI (requires auth)
router.post('/order', requireAuth, async (req, res) => {
  try {
    const { side, order_type, price_cents, size, stop_loss_cents, take_profit_cents, symbol } = req.body;
    if (!side || !size) return res.status(400).json({ error: 'Missing fields' });

    const result = await placeOrder({ userId: req.user.userId, side, order_type, price_cents, size, stop_loss_cents, take_profit_cents, symbol: symbol || 'BTCUSD' });
    res.json(result);
  } catch (err) {
    console.error('chart order error', err);
    res.status(500).json({ error: 'Order failed' });
  }
});

module.exports = router;
