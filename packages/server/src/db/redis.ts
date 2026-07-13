import Redis from 'ioredis'
import { createLogger } from '../logger.js'

const log = createLogger('redis')

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

let redis: Redis | null = null
let redisAvailable = false

export function getRedis(): Redis | null {
  return redisAvailable ? redis : null
}

export function isRedisAvailable(): boolean {
  return redisAvailable
}

export async function connectRedis(): Promise<void> {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,   // 不重试，一次失败就放弃
    lazyConnect: true,
    connectTimeout: 3000,
    enableOfflineQueue: false,
  })

  redis.on('error', () => {
    // 静默处理，连接失败不再重试
  })

  try {
    await redis.connect()
    redisAvailable = true
    log.info('connected', { url: REDIS_URL })
  } catch {
    redisAvailable = false
    log.warn('unavailable — running without message bus', { url: REDIS_URL })
    await redis.quit().catch(() => {})
    redis = null
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => {})
    log.info('disconnected')
    redis = null
    redisAvailable = false
  }
}
