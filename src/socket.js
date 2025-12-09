const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let ioInstance = null;

function setupSocket(httpServer) {
  const io = new Server(httpServer, { cors: { origin: '*' } });
  ioInstance = io;

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Auth token required'));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { userId: payload.userId, email: payload.email };
      return next();
    } catch (err) {
      return next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log('client connected', socket.id);
    socket.on('subscribe', (symbol) => socket.join(`asset:${symbol}`));
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

function broadcastCandle(candle) {
  if (!ioInstance) return;
  const symbol = candle.symbol || 'BTCUSDT';
  ioInstance.to(`asset:${symbol}`).emit('candle', candle);
}

module.exports = { setupSocket, broadcastTrade, broadcastPrice, broadcastCandle };
