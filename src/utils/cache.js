const redis = require('../config/redis')

const DEFAULT_TTL = 60;

async function cacheSet(key, value, ttlSeconds = DEFAULT_TTL) {
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    console.error('Redis SET error:', err);
  }
}

async function cacheGet(key) {
  try {
    const result = await redis.get(key);
    return result ? JSON.parse(result) : null;
  } catch (err) {
    console.error('Redis GET error:', err);
    return null;
  }
}

async function cacheDelete(key) {
  try {
    await redis.del(key);
  } catch (err) {
    console.error('Redis DELETE error:', err);
  }
}

module.exports = { cacheSet, cacheGet, cacheDelete };
