import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TriggerState } from '../../src/triggers/base.js'
import { ScriptTrigger, createScriptTrigger } from '../../src/triggers/script.js'
import type { TriggerConfig } from '../../src/triggers/types.js'

describe('ScriptTrigger', () => {
  let trigger: ScriptTrigger

  beforeEach(() => {
    trigger = createScriptTrigger(`test-script-${Date.now()}`, 'Test Script Trigger')
  })

  afterEach(async () => {
    if (trigger.isActive) {
      await trigger.stop().catch(() => {})
    }
    vi.clearAllMocks()
  })

  describe('getTriggerType', () => {
    it('returns custom type', () => {
      expect(trigger.getTriggerType()).toBe('custom')
    })
  })

  describe('initialization', () => {
    it('initializes with valid config', async () => {
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['hello'],
      })

      expect(trigger.isInitialized).toBe(true)
      expect(trigger.state).toBe(TriggerState.INITIALIZED)
    })

    it('throws error if command is missing', async () => {
      await expect(
        trigger.initialize({
          id: 'test-script',
          args: [],
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Script trigger requires a command')
    })

    it('throws error if args is missing', async () => {
      await expect(
        trigger.initialize({
          id: 'test-script',
          command: 'echo',
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Script trigger requires args array')
    })

    it('throws error if args is not an array', async () => {
      await expect(
        trigger.initialize({
          id: 'test-script',
          command: 'echo',
          args: 'not-array',
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Script trigger requires args array')
    })
  })

  describe('one-shot execution', () => {
    it('executes script successfully', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['hello'],
      })

      trigger.onEvent(handler)
      await trigger.start()

      expect(handler).toHaveBeenCalled()
      const event = handler.mock.calls[0]?.[0]
      expect(event).toMatchObject({
        triggerId: expect.stringContaining('test-script'),
        triggerType: 'custom',
        metadata: expect.objectContaining({
          source: 'script',
          command: 'echo',
          args: ['hello'],
          exitCode: 0,
        }),
      })
    })

    it('parses JSON output', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['{"key": "value"}'],
      })

      trigger.onEvent(handler)
      await trigger.start()

      const event = handler.mock.calls[0]?.[0]
      expect(event.payload).toEqual({ key: 'value' })
    })

    it('keeps string output if not valid JSON', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['not json'],
      })

      trigger.onEvent(handler)
      await trigger.start()

      const event = handler.mock.calls[0]?.[0]
      expect(event.payload).toBe('not json\n')
    })

    it('includes workflowId in metadata when provided', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['test'],
        workflowId: 'my-workflow',
      })

      trigger.onEvent(handler)
      await trigger.start()

      const event = handler.mock.calls[0]?.[0]
      expect(event.metadata.workflowId).toBe('my-workflow')
    })

    it('logs warning on script failure', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-script',
        command: 'sh',
        args: ['-c', 'echo error >&2; exit 1'],
      })

      trigger.onEvent(handler)
      await trigger.start()

      // Handler should not be called for failed scripts
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('periodic execution', () => {
    it('runs script at interval', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['test'],
        intervalMs: 100,
      })

      trigger.onEvent(handler)
      await trigger.start()

      // First execution should happen immediately
      expect(handler).toHaveBeenCalledTimes(1)

      // Wait for second execution
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(handler).toHaveBeenCalledTimes(2)

      await trigger.stop()
    })

    it('handles execution errors gracefully', async () => {
      const handler = vi.fn()
      const errorLog = vi.spyOn(console, 'error').mockImplementation()

      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['test'],
        intervalMs: 50,
      })

      trigger.onEvent(handler)
      await trigger.start()

      // Should still run despite errors
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(handler).toHaveBeenCalled()
      errorLog.mockRestore()

      await trigger.stop()
    })
  })

  describe('timeout handling', () => {
    it('kills script on timeout', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-script',
        command: 'sleep',
        args: ['10'],
        timeoutMs: 100,
      })

      trigger.onEvent(handler)
      await trigger.start()

      // Should timeout and not emit event
      expect(handler).not.toHaveBeenCalled()
    }, 5000)
  })

  describe('working directory and environment', () => {
    it('uses custom cwd', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-script',
        command: 'pwd',
        args: [],
        cwd: '/tmp',
      })

      trigger.onEvent(handler)
      await trigger.start()

      const event = handler.mock.calls[0]?.[0]
      expect(event.payload).toContain('/tmp')
    })

    it('uses custom environment variables', async () => {
      const handler = vi.fn()
      await trigger.initialize({
        id: 'test-script',
        command: 'sh',
        args: ['-c', 'echo $MY_VAR'],
        env: { MY_VAR: 'custom_value' },
      })

      trigger.onEvent(handler)
      await trigger.start()

      const event = handler.mock.calls[0]?.[0]
      expect(event.payload).toContain('custom_value')
    })
  })

  describe('health check', () => {
    it('returns not-running when stopped', async () => {
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['test'],
      })

      const health = await trigger.healthCheck()

      expect(health.healthy).toBe(false)
      expect(health.status).toBe('not-running')
    })

    it('returns running status when active', async () => {
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['test'],
        intervalMs: 1000,
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.status).toBe('running')

      await trigger.stop()
    })

    it('includes command and interval in details', async () => {
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['test'],
        intervalMs: 5000,
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.details).toMatchObject({
        command: 'echo',
        intervalMs: 5000,
      })

      await trigger.stop()
    })
  })

  describe('stop', () => {
    it('clears interval on stop', async () => {
      await trigger.initialize({
        id: 'test-script',
        command: 'echo',
        args: ['test'],
        intervalMs: 50,
      })

      await trigger.start()
      await new Promise((resolve) => setTimeout(resolve, 80))
      await trigger.stop()

      // After stop, no more executions should happen
      const handler = vi.fn()
      trigger.onEvent(handler)
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('factory function', () => {
    it('creates ScriptTrigger instance', () => {
      const trigger = createScriptTrigger('factory-test', 'Factory Test')

      expect(trigger).toBeInstanceOf(ScriptTrigger)
      expect(trigger.id).toBe('factory-test')
      expect(trigger.name).toBe('Factory Test')
      expect(trigger.getTriggerType()).toBe('custom')
    })
  })
})
