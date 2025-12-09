const BinanceAdapter = require('./binanceAdapter');

// Singleton adapter instance used across the app (market data + user stream)
const adapter = new BinanceAdapter();

module.exports = adapter;
