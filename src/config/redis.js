const Redis = require('ioredis');
const logger = require('../utils/logger');

let redisClient = null;
let isConnected = false;

const redisUrl = process.env.REDIS_URL;

if (redisUrl) {
    try {
        redisClient = new Redis(redisUrl, {
            maxRetriesPerRequest: 1,
            retryStrategy: (times) => {
                const delay = Math.min(times * 500, 5000);
                return delay;
            },
            lazyConnect: true,
            enableOfflineQueue: false,
            connectTimeout: 5000,
        });

        redisClient.on('connect', () => {
            isConnected = true;
            logger.info('✅ Redis client connected');
        });

        redisClient.on('ready', () => {
            isConnected = true;
            logger.info('🚀 Redis client ready');
        });

        redisClient.on('error', (err) => {
            isConnected = false;
            // Suppress unhandled exceptions, log as debug/warning
            logger.warn(`[Redis] Connection warning: ${err.message}`);
        });

        redisClient.on('close', () => {
            isConnected = false;
            logger.warn('[Redis] Connection closed');
        });

        redisClient.on('reconnecting', () => {
            logger.info('[Redis] Reconnecting to Redis server...');
        });

        // Initiate connection non-blockingly
        redisClient.connect().catch(err => {
            logger.warn(`[Redis] Initial connection attempt failed: ${err.message}. Running in graceful fallback mode.`);
        });
    } catch (err) {
        logger.warn(`[Redis] Initialization error: ${err.message}. Running in graceful fallback mode.`);
        redisClient = null;
        isConnected = false;
    }
} else {
    logger.info('ℹ️  No REDIS_URL configured. Running with in-memory caching and direct MongoDB fallback.');
}

/**
 * Check if Redis is currently connected and usable
 */
const isRedisAvailable = () => {
    return isConnected && redisClient && redisClient.status === 'ready';
};

/**
 * Retrieve parsed JSON value from Redis
 * @param {string} key
 * @returns {Promise<any|null>}
 */
const cacheGet = async (key) => {
    if (!isRedisAvailable()) return null;
    try {
        const raw = await redisClient.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        logger.warn(`[Redis] cacheGet error for key "${key}": ${err.message}`);
        return null;
    }
};

/**
 * Store a JSON-serializable value in Redis with a TTL in seconds
 * @param {string} key
 * @param {any} value
 * @param {number} ttlSeconds
 */
const cacheSet = async (key, value, ttlSeconds = 120) => {
    if (!isRedisAvailable()) return;
    try {
        const serialized = JSON.stringify(value);
        if (ttlSeconds && ttlSeconds > 0) {
            await redisClient.setex(key, ttlSeconds, serialized);
        } else {
            await redisClient.set(key, serialized);
        }
    } catch (err) {
        logger.warn(`[Redis] cacheSet error for key "${key}": ${err.message}`);
    }
};

/**
 * Delete one or more specific keys from Redis
 * @param {...string} keys
 */
const cacheDel = async (...keys) => {
    if (!isRedisAvailable() || keys.length === 0) return;
    try {
        const validKeys = keys.filter(k => typeof k === 'string' && k.length > 0);
        if (validKeys.length > 0) {
            await redisClient.del(...validKeys);
        }
    } catch (err) {
        logger.warn(`[Redis] cacheDel error: ${err.message}`);
    }
};

/**
 * Invalidate keys matching a pattern prefix using non-blocking SCAN (e.g. "adminStats:*", "teacher:*")
 * @param {string} pattern
 */
const cacheInvalidatePattern = async (pattern) => {
    if (!isRedisAvailable() || !pattern) return;
    try {
        const stream = redisClient.scanStream({
            match: pattern,
            count: 100
        });

        const keysToDelete = [];
        stream.on('data', (resultKeys) => {
            for (let i = 0; i < resultKeys.length; i++) {
                keysToDelete.push(resultKeys[i]);
            }
        });

        await new Promise((resolve) => {
            stream.on('end', async () => {
                if (keysToDelete.length > 0) {
                    try {
                        await redisClient.del(...keysToDelete);
                    } catch (_) {}
                }
                resolve();
            });
            stream.on('error', () => resolve());
        });
    } catch (err) {
        logger.warn(`[Redis] cacheInvalidatePattern error for pattern "${pattern}": ${err.message}`);
    }
};

module.exports = {
    redisClient,
    isRedisAvailable,
    cacheGet,
    cacheSet,
    cacheDel,
    cacheInvalidatePattern
};
