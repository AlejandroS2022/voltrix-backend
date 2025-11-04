require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { initDb } = require('./src/db');
const authRoutes = require('./src/routes/auth');
const tradingRoutes = require('./src/routes/trading');
const { setupSocket } = require('./src/socket');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// simple health
app.get('/health', (req, res) => res.json({ ok: true, time: new Date() }));

// route groups
app.use('/api/auth', authRoutes);
app.use('/api/trade', tradingRoutes);

// init DB then start
(async () => {
  try {
    await initDb();
    setupSocket(server); // Socket.IO wiring
    const port = process.env.PORT || 3000;
    server.listen(port, () => console.log(`Server listening on ${port}`));
  } catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
  }
})();
