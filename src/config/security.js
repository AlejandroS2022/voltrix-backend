const helmet = require('helmet');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require("rate-limit-redis");
const RedisClient = require('ioredis')
const redis = require('./redis')
const xssClean = require('xss-clean');
const compression = require('compression');
const morgan = require('morgan');
const { errors } = require('celebrate');
const cookieParser = require('cookie-parser')

const REDIS_URL = process.env.REDIS_URL;

function setupSecurity(app) {
  app.use(helmet({
    contentSecurityPolicy: false,
  }));

  const allowedOrigins = [
    'http://localhost:5173',
    'https://voltrixgeneral.com'
  ];
  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
  }));

  app.use(xssClean());

  const client = redis;
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand: (...args) => client.call(...args),
    }),
  })
  app.use(limiter);

  app.use(compression());

  app.use(morgan('dev'));

  app.use(cookieParser());
}

module.exports = { setupSecurity };
