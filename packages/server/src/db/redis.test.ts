import { describe, it, expect, vi, beforeEach } from 'vitest'

// Control whether the mock connect resolves or rejects
let mockConnectRejects = false

vi.mock('ioredis', () => {
  function MockRedis(this: any, _url: string, _opts?: Record<string, unknown>) {
    return {
      connect: vi.fn().mockImplementation(() => {
        if (mockConnectRejects) {
          return Promise.reject(new Error('connection refused'))
        }
        return Promise.resolve()
      }),
      quit: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    }
  }
  return { default: MockRedis }
})

describe('redis', () => {
  let redisModule: typeof import('../db/redis.js')

  beforeEach(async () => {
    vi.resetModules()
    mockConnectRejects = false
    redisModule = await import('../db/redis.js')
  })

  describe('initial state', () => {
    it('redis is not available before connection', () => {
      expect(redisModule.isRedisAvailable()).toBe(false)
      expect(redisModule.getRedis()).toBeNull()
    })
  })

  describe('connectRedis - failure', () => {
    it('remains unavailable when connection fails', async () => {
      mockConnectRejects = true
      await redisModule.connectRedis()
      expect(redisModule.isRedisAvailable()).toBe(false)
      expect(redisModule.getRedis()).toBeNull()
    })
  })

  describe('connectRedis - success', () => {
    it('sets available flag when connection succeeds', async () => {
      await redisModule.connectRedis()
      expect(redisModule.isRedisAvailable()).toBe(true)
      expect(redisModule.getRedis()).not.toBeNull()
    })
  })

  describe('closeRedis', () => {
    it('cleans up state when closing', async () => {
      await redisModule.connectRedis()
      expect(redisModule.isRedisAvailable()).toBe(true)

      await redisModule.closeRedis()
      expect(redisModule.isRedisAvailable()).toBe(false)
      expect(redisModule.getRedis()).toBeNull()
    })

    it('handles close when never connected', async () => {
      await expect(redisModule.closeRedis()).resolves.toBeUndefined()
    })
  })
})
