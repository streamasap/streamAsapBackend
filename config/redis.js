import Redis from 'ioredis';
import logger from './logger.js';

const redisUrl = process.env.REDIS_URL; 

if (!redisUrl) {
  logger.error('REDIS_URL environment variable is missing.');
}

// Connect using the Upstash connection string
const redis = new Redis(redisUrl, {
  // Upstash uses TLS connections (rediss://)
  tls: redisUrl && redisUrl.startsWith('rediss://') ? {} : undefined,
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => {
  logger.info('Connected to Upstash Redis database successfully.');
});

redis.on('error', (err) => {
  logger.error('Upstash Redis connection error:', err.message);
});


export default redis;