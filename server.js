require('dotenv').config();
const express = require('express');
const http = require('http');
const { setupSecurity } = require('./src/config/security') 
const { initDb } = require('./src/db');

const authRoutes = require('./src/routes/auth');
const tradingRoutes = require('./src/routes/trading');
const tradingviewRoutes = require('./src/routes/tradingviewDatafeed');
const { setupSocket } = require('./src/socket');
const { startPriceStream } = require('./src/services/priceStream');
const { startAggregator } = require('./src/services/candleAggregator');

const app = express();
const server = http.createServer(app);
setupSecurity(app)

// Mount Stripe webhook (and stripe routes) before global JSON parser so webhook
// can access raw body for signature verification.
const stripeRoutes = require('./src/routes/stripe');
app.use('/api/stripe', stripeRoutes);

app.use(express.json());

// routes
app.use('/api/auth', authRoutes);
app.use('/api/trade', tradingRoutes);
app.use('/datafeed', tradingviewRoutes);
const priceRoutes = require('./src/routes/price');
app.use('/api/price', priceRoutes);
  const adminRoutes = require('./src/routes/admin');
  app.use('/api/admin', adminRoutes);

  // Celebrate errors handler should be registered after routes so validation errors produce 400
  const { errors: celebrateErrors } = require('celebrate');
  app.use(celebrateErrors());

  // generic error handler (should be last middleware) — return JSON for uncaught errors
  app.use((err, req, res, next) => {
    // celebrate errors are handled earlier by setupSecurity.errors(), but catch-all here
    console.error('Unhandled error:', err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    const message = err.message || 'Internal Server Error';
    res.status(status).json({ error: message });
  });

(async () => {
  try {
    await initDb();
    setupSocket(server);
    // start realtime components
    await startAggregator();
    startPriceStream();
    // start stop-loss / take-profit trigger worker
    const { startSlTpWorker } = require('./src/services/sltpWorker');
    startSlTpWorker();
    // start pending position activator
    const { startPendingActivator } = require('./src/services/pendingActivator');
    startPendingActivator();
    // Binance adapter is disabled — migrating to Twelve Data for Forex/Stock prices.
    // To re-enable, uncomment the block below and set BINANCE_ENABLE=true in .env
    // const binance = require('./src/services/binanceAdapterInstance');
    // const binanceSymbolsEnv = process.env.BINANCE_SYMBOLS || 'BTCUSDT,ETHUSDT,BNBUSDT';
    // const binanceSymbols = binanceSymbolsEnv.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    // binance.startMarketData(binanceSymbols);
    // app.locals.binanceAdapter = binance;

    // start Twelve Data adapter (Forex/Stock prices) - configure via TWELVEDATA_SYMBOLS env var
    const twelveData = require('./src/services/twelveDataAdapterInstance');
    const tdSymbolsEnv = process.env.TWELVEDATA_SYMBOLS || 'BTC/USD,ETH/USD,EUR/USD,GBP/USD,USD/JPY,AUD/USD,USD/CAD,AAPL,MSFT,GOOGL,AMZN,TSLA';
    const tdSymbols = tdSymbolsEnv.split(',').map(s => s.trim()).filter(Boolean);
    twelveData.startMarketData(tdSymbols);
    app.locals.twelveDataAdapter = twelveData;
    const port = process.env.PORT || 3000;
    server.listen(port, () => console.log(`Server listening on ${port}`));
  } catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
  }
})();
