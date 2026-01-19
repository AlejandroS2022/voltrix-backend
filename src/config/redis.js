const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL;

let redis;
if (!REDIS_URL) {
	// fallback to defaults (localhost)
	redis = new Redis();
} else if (/^redis:\/\//.test(REDIS_URL)) {
	// full redis URI
	redis = new Redis(REDIS_URL);
} else if (REDIS_URL.includes(':')) {
	// host:port pattern (e.g. localhost:6379)
	const [host, portStr] = REDIS_URL.split(':');
	const port = parseInt(portStr, 10) || 6379;
	redis = new Redis({ host, port });
} else {
	// bare host
	redis = new Redis({ host: REDIS_URL });
}

redis.on("connect", () => console.log("Redis connected"));
redis.on("error", (err) => console.error("Redis error: ", err));

module.exports = redis;