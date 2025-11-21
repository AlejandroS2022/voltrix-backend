const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL;

let redis = new Redis(REDIS_URL);

if (process.env.NODE_ENV === 'production') {
  redis = new Redis(REDIS_URL, {
    tls: {
      rejectUnauthorized: false
    }
  });
}

redis.on("connect", () => console.log("Redis connected"));
redis.on("error", (err) => console.error("Redis error: ", err));

module.exports = redis;