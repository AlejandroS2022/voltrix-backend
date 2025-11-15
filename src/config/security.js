const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const xssClean = require('xss-clean');
const compression = require('compression');
const morgan = require('morgan');

function setupSecurity(app) {
  app.use(helmet({
    contentSecurityPolicy: false,
  }));

  const allowedOrigins = [
    'http://localhost:5173'
  ];
  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
  }));

  app.use(xssClean());

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api', limiter);

  app.use(compression());

  app.use(morgan('dev'));
}

module.exports = { setupSecurity };
