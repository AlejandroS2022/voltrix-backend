require('dotenv').config();
const express = require('express');
const http = require('http');
const { setupSecurity } = require('./src/config/security') 
const { initDb } = require('./src/db');

const authRoutes = require('./src/routes/auth');
const tradingRoutes = require('./src/routes/trading');
const { setupSocket } = require('./src/socket');

const app = express();
const server = http.createServer(app);
setupSecurity(app)

app.use(express.json());

// routes
app.use('/api/auth', authRoutes);
app.use('/api/trade', tradingRoutes);

(async () => {
  try {
    await initDb();
    setupSocket(server);
    const port = process.env.PORT || 3000;
    server.listen(port, () => console.log(`Server listening on ${port}`));
  } catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
  }
})();
