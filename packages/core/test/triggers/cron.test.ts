import { describe, expect, it, vi } from 'vitest'
import { TriggerState } from '../../src/triggers/base.js'
import { CronTrigger, createCronTrigger } from '../../src/triggers/cron.js'
import type { TriggerConfig } from '../../src/triggers/types.js'

describe('CronTrigger', () => {
  describe('getTriggerType', () => {
    it('returns cron type', () => {
      const trigger = createCronTrigger('cron-type', 'Test Cron Trigger')
      expect(trigger.getTriggerType()).toBe('cron')
    })
  })

  describe('initialization', () => {
    it('initializes with valid cron schedule', async () => {
      const trigger = createCronTrigger('cron-valid', 'Valid Cron')
      await trigger.initialize({
        id: 'cron-valid',
        schedule: '0 * * * *', // every hour
      })

      expect(trigger.isInitialized).toBe(true)
      expect(trigger.state).toBe(TriggerState.INITIALIZED)

      await trigger.stop().catch(() => {})
    })

    it('throws error for invalid cron expression', async () => {
      const trigger = createCronTrigger('cron-invalid', 'Invalid Cron')
      await expect(
        trigger.initialize({
          id: 'cron-invalid',
          schedule: 'invalid',
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Invalid cron schedule')
    })

    it('throws error for missing schedule', async () => {
      const trigger = createCronTrigger('cron-missing', 'Missing Cron')
      await expect(
        trigger.initialize({
          id: 'cron-missing',
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Invalid cron schedule')
    })
  })

  describe('scheduling', () => {
    it('schedules next run after start', async () => {
      const handler = vi.fn()
      const trigger = createCronTrigger('cron-schedule', 'Schedule Cron')
      await trigger.initialize({
        id: 'cron-schedule',
        schedule: '0 * * * *', // every hour
      })

      trigger.onEvent(handler)
      await trigger.start()

      // Verify trigger is active and has scheduled next run
      expect(trigger.isActive).toBe(true)

      const health = await trigger.healthCheck()
      expect(health.details.nextRun).toBeDefined()
      expect(health.details.schedule).toBe('0 * * * *')

      await trigger.stop()
    })

    it('includes workflowId in config', async () => {
      const trigger = createCronTrigger('cron-workflow', 'Workflow Cron')
      await trigger.initialize({
        id: 'cron-workflow',
        schedule: '0 * * * *',
        workflowId: 'my-workflow',
      })

      expect(trigger.isInitialized).toBe(true)

      await trigger.stop().catch(() => {})
    })
  })

  describe('health check', () => {
    it('returns healthy when running', async () => {
      const trigger = createCronTrigger('cron-health', 'Health Cron')
      await trigger.initialize({
        id: 'cron-health',
        schedule: '0 * * * *',
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.status).toBe('healthy')
      expect(health.details).toMatchObject({
        schedule: '0 * * * *',
      })

      await trigger.stop()
    })

    it('includes nextRun in details', async () => {
      const trigger = createCronTrigger('cron-nextrun', 'NextRun Cron')
      await trigger.initialize({
        id: 'cron-nextrun',
        schedule: '0 * * * *',
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.details.nextRun).toBeDefined()

      await trigger.stop()
    })
  })

  describe('stop', () => {
    it('clears timeout on stop', async () => {
      const trigger = createCronTrigger('cron-stop', 'Stop Cron')
      await trigger.initialize({
        id: 'cron-stop',
        schedule: '0 * * * *',
      })

      await trigger.start()
      expect(trigger.isActive).toBe(true)

      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })
  })

  describe('factory function', () => {
    it('creates CronTrigger instance', () => {
      const trigger = createCronTrigger('factory-test', 'Factory Test')

      expect(trigger).toBeInstanceOf(CronTrigger)
      expect(trigger.id).toBe('factory-test')
      expect(trigger.name).toBe('Factory Test')
      expect(trigger.getTriggerType()).toBe('cron')
    })
  })
})
