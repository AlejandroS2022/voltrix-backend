const memjs = require('memjs');

const mc = memjs.Client.create(process.env.MEMCACHED_SERVERS || 'localhost:11211', {
  username: process.env.MEMCACHED_USER || undefined,
  password: process.env.MEMCACHED_PASS || undefined,
});

async function cacheSet(key, value, ttlSeconds = 60) {
  try {
    await mc.set(key, JSON.stringify(value), { expires: ttlSeconds });
  } catch (err) {
    console.error('Memcached set error:', err);
  }
}

async function cacheGet(key) {
  try {
    const result = await mc.get(key);
    if (result.value) {
      return JSON.parse(result.value.toString());
    }
    return null;
  } catch (err) {
    console.error('Memcached get error:', err);
    return null;
  }
}

async function cacheDelete(key) {
  try {
    await mc.delete(key);
  } catch (err) {
    console.error('Memcached delete error:', err);
  }
}

module.exports = { cacheSet, cacheGet, cacheDelete };
