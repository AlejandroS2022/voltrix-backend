const express = require('express');
const router = express.Router();
const redis = require('../config/redis');

// GET /api/price/:symbol -> returns latest tick for symbol
router.get('/:symbol', async (req, res) => {
  try {
    let symbol = (req.params.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const key = `tick_latest:${symbol}`;
    const v = await redis.get(key);
    if (!v) return res.status(404).json({ error: 'no_price' });
    const obj = JSON.parse(v);
    res.json(obj);
  } catch (err) {
    console.error('price route error', err);
    res.status(500).json({ error: 'price_error' });
  }
});

module.exports = router;
