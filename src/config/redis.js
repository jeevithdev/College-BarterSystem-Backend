const Redis = require("ioredis");

let redisClient = null;

const createRedisConnection = () => {
  try {
    const config = {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB) || 0,
      connectTimeout: 10000,
      lazyConnect: true,
      retryDelayOnFailover: 100,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
    };

    redisClient = new Redis(config);

    redisClient.on("connect", () => {
      console.log("✅ Connected to Redis");
    });

    redisClient.on("error", (err) => {
      console.error("❌ Redis connection error:", err.message);
    });

    redisClient.on("close", () => {
      console.log("📪 Redis connection closed");
    });

    return redisClient;
  } catch (error) {
    console.error("❌ Failed to create Redis connection:", error.message);
    return null;
  }
};

const getRedisClient = () => {
  if (!redisClient) {
    redisClient = createRedisConnection();
  }
  return redisClient;
};

const closeRedisConnection = async () => {
  if (redisClient) {
    try {
      await redisClient.quit();
      redisClient = null;
    } catch (error) {
      console.error("Error closing Redis connection:", error.message);
      redisClient = null;
    }
  }
};

// Health check function for Redis
const isRedisHealthy = async () => {
  try {
    const client = getRedisClient();
    if (!client) return false;

    const result = await client.ping();
    return result === "PONG";
  } catch (error) {
    return false;
  }
};

module.exports = {
  createRedisConnection,
  getRedisClient,
  closeRedisConnection,
  isRedisHealthy,
};