const { Server } = require('socket.io');

let ioInstance = null;

function setupSocket(httpServer) {
  const io = new Server(httpServer, { cors: { origin: '*' } });
  ioInstance = io;

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
  const symbol = 'BTCUSD';
  ioInstance.to(`asset:${symbol}`).emit('trade', trade);
}

module.exports = { setupSocket, broadcastTrade };
