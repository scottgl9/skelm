import { describe, expect, it, vi } from 'vitest'
import { TriggerState } from '../../src/triggers/base.js'
import { MatrixTrigger, createMatrixTrigger } from '../../src/triggers/matrix.js'
import type { TriggerConfig } from '../../src/triggers/types.js'

describe('MatrixTrigger', () => {
  describe('getTriggerType', () => {
    it('returns matrix type', () => {
      const trigger = createMatrixTrigger('matrix-type', 'Test Matrix')
      expect(trigger.getTriggerType()).toBe('matrix')
    })
  })

  describe('initialization', () => {
    it('initializes with valid config', async () => {
      const id = `matrix-valid-${Date.now()}`
      const trigger = createMatrixTrigger(id, 'Valid Matrix')
      await trigger.initialize({
        id,
        homeserverUrl: 'https://matrix.org',
        accessToken: 'test-token',
        userId: '@test:matrix.org',
        roomIds: ['!test:matrix.org'],
      })

      expect(trigger.isInitialized).toBe(true)
      expect(trigger.state).toBe(TriggerState.INITIALIZED)

      await trigger.stop().catch(() => {})
    })

    it('throws error for missing homeserverUrl', async () => {
      const trigger = createMatrixTrigger('matrix-missing', 'Missing Matrix')
      await expect(
        trigger.initialize({
          id: 'matrix-missing',
          accessToken: 'test-token',
          userId: '@test:matrix.org',
          roomIds: ['!test:matrix.org'],
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Matrix trigger requires homeserverUrl')
    })

    it('throws error for missing access token', async () => {
      const trigger = createMatrixTrigger('matrix-notoken', 'No Token Matrix')
      await expect(
        trigger.initialize({
          id: 'matrix-notoken',
          homeserverUrl: 'https://matrix.org',
          userId: '@test:matrix.org',
          roomIds: ['!test:matrix.org'],
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Matrix trigger requires accessToken')
    })

    it('throws error for missing room IDs', async () => {
      const trigger = createMatrixTrigger('matrix-noroom', 'No Room Matrix')
      await expect(
        trigger.initialize({
          id: 'matrix-noroom',
          homeserverUrl: 'https://matrix.org',
          accessToken: 'test-token',
          userId: '@test:matrix.org',
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Matrix trigger requires at least one roomId')
    })
  })

  describe('start/stop', () => {
    it('starts and connects to Matrix', async () => {
      const handler = vi.fn()
      const id = `matrix-start-${Date.now()}`
      const trigger = createMatrixTrigger(id, 'Start Matrix')
      await trigger.initialize({
        id,
        homeserverUrl: 'https://matrix.org',
        accessToken: 'test-token',
        userId: '@test:matrix.org',
        roomIds: ['!test:matrix.org'],
      })

      trigger.onEvent(handler)
      await trigger.start()

      expect(trigger.isActive).toBe(true)

      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })

    it('disconnects on stop', async () => {
      const id = `matrix-stop-${Date.now()}`
      const trigger = createMatrixTrigger(id, 'Stop Matrix')
      await trigger.initialize({
        id,
        homeserverUrl: 'https://matrix.org',
        accessToken: 'test-token',
        userId: '@test:matrix.org',
        roomIds: ['!test:matrix.org'],
      })

      await trigger.start()
      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })
  })

  describe('health check', () => {
    it('returns healthy when running', async () => {
      const id = `matrix-health-${Date.now()}`
      const trigger = createMatrixTrigger(id, 'Health Matrix')
      await trigger.initialize({
        id,
        homeserverUrl: 'https://matrix.org',
        accessToken: 'test-token',
        userId: '@test:matrix.org',
        roomIds: ['!test:matrix.org'],
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.status).toBe('listening')

      await trigger.stop()
    })

    it('includes roomIds in details', async () => {
      const id = `matrix-details-${Date.now()}`
      const trigger = createMatrixTrigger(id, 'Details Matrix')
      await trigger.initialize({
        id,
        homeserverUrl: 'https://matrix.org',
        accessToken: 'test-token',
        userId: '@test:matrix.org',
        roomIds: ['!custom:matrix.org'],
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.details).toMatchObject({
        roomCount: 1,
        homeserver: 'https://matrix.org',
      })

      await trigger.stop()
    })
  })

  describe('factory function', () => {
    it('creates MatrixTrigger instance', () => {
      const trigger = createMatrixTrigger('factory-test', 'Factory Test')

      expect(trigger).toBeInstanceOf(MatrixTrigger)
      expect(trigger.id).toBe('factory-test')
      expect(trigger.name).toBe('Factory Test')
      expect(trigger.getTriggerType()).toBe('matrix')
    })
  })
})
