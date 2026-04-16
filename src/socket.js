const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const redis = require('./config/redis');

let ioInstance = null;

function setupSocket(httpServer) {
  const io = new Server(httpServer, { cors: { origin: '*' } });
  ioInstance = io;
  global.io = io;
  // Allow unauthenticated (guest) connections so public price feeds remain available
  // If a token is provided, verify and attach user info; otherwise continue as guest.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(); // allow guest
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { userId: payload.userId, email: payload.email, isAdmin: payload.isAdmin };
    } catch (err) {
      console.warn('socket auth failed, proceeding as guest');
    }
    return next();
  });

  io.on('connection', (socket) => {
    console.log('client connected', socket.id);
    // Auto-join a private room for authenticated users so server can notify them directly
    if (socket.user && socket.user.userId) {
      try { socket.join(`user:${socket.user.userId}`); } catch (e) {}

      if (socket.user.isAdmin || socket.user.is_admin) {
        try { 
          socket.join('admin_room'); 
          console.log(`Admin ${socket.user.userId} Joined to admin_room`);
        } catch (e) {}
      }
    }
    socket.on('subscribe', async (symbol) => {
      if (symbol) {
        socket.join(`asset:${symbol}`);
        // On subscribe, immediately send the latest price for the symbol from Redis if available
        try {
          const raw = await redis.get(`tick_latest:${symbol}`);
          if (raw) {
            const tick = JSON.parse(raw);
            socket.emit('price', tick);
          }
        } catch (e) {
          console.warn('Failed to send latest price on subscribe for', symbol, e);
        }
      }
    });
    socket.on('unsubscribe', (symbol) => {
      if (symbol) socket.leave(`asset:${symbol}`);
    });

    // New: allow frontend to request all prices at any time
    socket.on('get_all_prices', async (cb) => {
      try {
        const keys = await redis.keys('tick_latest:*');
        const prices = {};
        for (const key of keys) {
          const raw = await redis.get(key);
          if (!raw) continue;
          try {
            const tick = JSON.parse(raw);
            prices[tick.symbol] = tick;
          } catch (e) {}
        }
        if (typeof cb === 'function') cb(prices);
        else socket.emit('all_prices', prices);
      } catch (e) {
        console.warn('Failed to get all prices for frontend', e);
        if (typeof cb === 'function') cb({});
        else socket.emit('all_prices', {});
      }
    });

    socket.on('disconnect', () => console.log('client disconnected', socket.id));
  });

  return io;
}

// Broadcast helper (used by matchingEngine)
function broadcastTrade(trade) {
  if (!ioInstance) return;
  const symbol = 'BTCUSDT';
  ioInstance.to(`asset:${symbol}`).emit('trade', trade);
}

function broadcastPrice(price) {
  if (!ioInstance) return;
  const symbol = price.symbol || 'BTCUSDT';
  ioInstance.to(`asset:${symbol}`).emit('price', price);
}

function notifyUser(userId, event, payload) {
  if (!ioInstance || !userId) {
    console.log('[Socket] notifyUser skipped: ioInstance or userId missing');
    return;
  }
  console.log(`[Socket] notifyUser: userId=${userId}, event=${event}, payload=`, payload);
  ioInstance.to(`user:${userId}`).emit(event, payload);
}

function broadcastCandle(candle) {
  if (!ioInstance) return;
  const symbol = candle.symbol || 'BTCUSDT';
  ioInstance.to(`asset:${symbol}`).emit('candle', candle);
}

function notifyAdmin(event, payload) {
  if (!ioInstance) return;
  ioInstance.to('admin_room').emit(event, payload);
}

module.exports = { setupSocket, broadcastTrade, broadcastPrice, broadcastCandle, notifyUser, notifyAdmin };
