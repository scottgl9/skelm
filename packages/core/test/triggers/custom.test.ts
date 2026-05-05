import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TriggerState } from '../../src/triggers/base.js'
import { CustomTrigger, createCustomTrigger } from '../../src/triggers/custom.js'
import type { TriggerConfig, TriggerHealthStatus } from '../../src/triggers/types.js'

describe('CustomTrigger', () => {
  let trigger: CustomTrigger

  beforeEach(() => {
    trigger = createCustomTrigger(`test-custom-${Date.now()}`, 'Test Custom Trigger')
  })

  afterEach(async () => {
    if (trigger.isActive) {
      await trigger.stop().catch(() => {})
    }
  })

  describe('getTriggerType', () => {
    it('returns custom type', () => {
      expect(trigger.getTriggerType()).toBe('custom')
    })
  })

  describe('lifecycle', () => {
    it('initializes with handler function', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-custom',
        handler,
      })

      expect(trigger.isInitialized).toBe(true)
      expect(trigger.state).toBe(TriggerState.INITIALIZED)
    })

    it('throws error if handler is missing', async () => {
      await expect(
        trigger.initialize({
          id: 'test-custom',
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Custom trigger requires a handler function')
    })

    it('executes handler on start', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-custom',
        handler,
      })

      await trigger.start()

      expect(handler).toHaveBeenCalled()
      expect(trigger.isActive).toBe(true)
    })

    it('stops successfully', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-custom',
        handler,
      })

      await trigger.start()
      await trigger.stop()

      expect(trigger.state).toBe(TriggerState.STOPPED)
    })

    it('handles handler errors', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Handler failed'))
      await trigger.initialize({
        id: 'test-custom',
        handler,
      })

      await expect(trigger.start()).rejects.toThrow('Handler failed')
      expect(trigger.state).toBe(TriggerState.ERROR)
    })
  })

  describe('health check', () => {
    it('returns not-running when stopped', async () => {
      await trigger.initialize({
        id: 'test-custom',
        handler: vi.fn(),
      })

      const health = await trigger.healthCheck()

      expect(health.healthy).toBe(false)
      expect(health.status).toBe('not-running')
    })

    it('returns healthy when running', async () => {
      await trigger.initialize({
        id: 'test-custom',
        handler: vi.fn(),
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.status).toBe('running')
    })

    it('uses custom health check if provided', async () => {
      const customCheck = vi.fn().mockResolvedValue(false)
      await trigger.initialize({
        id: 'test-custom',
        handler: vi.fn(),
        healthCheck: customCheck,
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(customCheck).toHaveBeenCalled()
      expect(health.healthy).toBe(false)
      expect(health.status).toBe('unhealthy')
    })
  })

  describe('state management', () => {
    it('gets state value', async () => {
      await trigger.initialize({
        id: 'test-custom',
        handler: vi.fn(),
        state: { key: 'value' },
      })

      const value = trigger.getState<string>('key')
      expect(value).toBe('value')
    })

    it('returns undefined for missing key', async () => {
      await trigger.initialize({
        id: 'test-custom',
        handler: vi.fn(),
        state: {},
      })

      const value = trigger.getState('missing')
      expect(value).toBeUndefined()
    })

    it('sets state value', async () => {
      await trigger.initialize({
        id: 'test-custom',
        handler: vi.fn(),
        state: {},
      })

      trigger.setState('newKey', 'newValue')
      const value = trigger.getState<string>('newKey')

      expect(value).toBe('newValue')
    })

    it('warns when setting state without initialized state', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation()

      await trigger.initialize({
        id: 'test-custom',
        handler: vi.fn(),
      })

      trigger.setState('key', 'value')

      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('event emission', () => {
    it('emits event with payload', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-custom',
        handler,
      })

      trigger.onEvent(handler)
      await (
        trigger as unknown as {
          emitEvent: (p: unknown, m?: Record<string, unknown>) => Promise<void>
        }
      ).emitEvent({ data: 'test' }, { source: 'test' })

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerId: expect.stringContaining('test-custom'),
          triggerType: 'custom',
          payload: { data: 'test' },
          metadata: { source: 'test' },
        }),
      )
    })

    it('emits event with default metadata', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-custom',
        handler,
      })

      trigger.onEvent(handler)
      await (
        trigger as unknown as {
          emitEvent: (p: unknown, m?: Record<string, unknown>) => Promise<void>
        }
      ).emitEvent({ data: 'test' })

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            source: 'custom',
          }),
        }),
      )
    })
  })

  describe('factory function', () => {
    it('creates CustomTrigger instance', () => {
      const trigger = createCustomTrigger('factory-test', 'Factory Test')

      expect(trigger).toBeInstanceOf(CustomTrigger)
      expect(trigger.id).toBe('factory-test')
      expect(trigger.name).toBe('Factory Test')
      expect(trigger.getTriggerType()).toBe('custom')
    })
  })
})
