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
    // start Binance adapter (market data + order placement integration)
    const binance = require('./src/services/binanceAdapterInstance');
    // start market data for main symbols (configurable via BINANCE_SYMBOLS env var)
    const symbolsEnv = process.env.BINANCE_SYMBOLS || 'BTCUSDT,ETHUSDT,BNBUSDT';
    const symbols = symbolsEnv.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    binance.startMarketData(symbols);
    // NOTE: user-data stream and broker order placement are disabled — broker used only for market data
    app.locals.binanceAdapter = binance;
    const port = process.env.PORT || 3000;
    server.listen(port, () => console.log(`Server listening on ${port}`));
  } catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
  }
})();
