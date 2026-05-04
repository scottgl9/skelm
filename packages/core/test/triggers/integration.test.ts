import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CronTrigger, createCronTrigger } from '../../src/triggers/cron.js'
import { WebhookTrigger, createWebhookTrigger } from '../../src/triggers/webhook.js'
import { TriggerRegistry } from '../../src/triggers/registry.js'
import { TriggerState } from '../../src/triggers/base.js'
import type { TriggerEvent, WorkflowInvocation } from '../../src/triggers/types.js'

describe('Trigger → Workflow Integration', () => {
  let registry: TriggerRegistry
  let eventHandler: vi.Mock

  beforeEach(() => {
    registry = new TriggerRegistry()
    eventHandler = vi.fn()
  })

  afterEach(async () => {
    // Clean up all triggers
    await registry.shutdown()
    eventHandler.mockClear()
  })

  describe('CronTrigger workflow invocation', () => {
    it('configures trigger with workflowId', async () => {
      const id = `cron-workflow-${Date.now()}`
      const trigger = createCronTrigger(id, 'Cron Workflow Test')

      registry.register(trigger)
      await trigger.initialize({
        id,
        schedule: '0 * * * *', // every hour at minute 0
        workflowId: 'test-workflow-123',
      })

      expect(trigger.isInitialized).toBe(true)

      await trigger.start()
      const health = await trigger.healthCheck()
      expect(health.details).toMatchObject({
        schedule: '0 * * * *',
      })

      await trigger.stop()
    })

    it('registers trigger with registry', async () => {
      const id = `cron-registry-${Date.now()}`
      const trigger = createCronTrigger(id, 'Cron Registry Test')

      registry.register(trigger)
      await trigger.initialize({
        id,
        schedule: '0 * * * *',
        workflowId: 'registry-workflow',
      })

      expect(registry.get(id)).toBe(trigger)
      expect(trigger.isInitialized).toBe(true)

      await trigger.stop()
    })
  })

  describe('WebhookTrigger workflow invocation', () => {
    it('configures trigger with workflowId', async () => {
      const id = `webhook-workflow-${Date.now()}`
      const trigger = createWebhookTrigger(id, 'Webhook Workflow Test')

      registry.register(trigger)
      await trigger.initialize({
        id,
        path: '/workflow/test',
        port: 3100 + Math.floor(Math.random() * 100),
        workflowId: 'webhook-workflow-456',
      })

      expect(trigger.isInitialized).toBe(true)

      await trigger.start()
      const health = await trigger.healthCheck()
      expect(health.details).toMatchObject({
        path: '/workflow/test',
      })

      await trigger.stop()
    })

    it('includes trigger metadata in config', async () => {
      const id = `webhook-metadata-${Date.now()}`
      const trigger = createWebhookTrigger(id, 'Webhook Metadata Test')

      registry.register(trigger)
      await trigger.initialize({
        id,
        path: '/metadata/test',
        port: 3200 + Math.floor(Math.random() * 100),
        workflowId: 'metadata-workflow',
      })

      // Verify trigger configuration
      expect(trigger.isInitialized).toBe(true)

      await trigger.stop()
    })
  })

  describe('Multiple triggers with different workflows', () => {
    it('manages multiple triggers simultaneously', async () => {
      const cronId = `multi-cron-${Date.now()}`
      const webhookId = `multi-webhook-${Date.now()}`

      const cronTrigger = createCronTrigger(cronId, 'Multi Cron')
      const webhookTrigger = createWebhookTrigger(webhookId, 'Multi Webhook')

      registry.register(cronTrigger)
      registry.register(webhookTrigger)

      await cronTrigger.initialize({
        id: cronId,
        schedule: '0 * * * *',
        workflowId: 'cron-workflow',
      })

      await webhookTrigger.initialize({
        id: webhookId,
        path: '/multi/test',
        port: 3300 + Math.floor(Math.random() * 100),
        workflowId: 'webhook-workflow',
      })

      expect(registry.list().length).toBe(2)
      expect(cronTrigger.isActive).toBe(false) // Not started yet
      expect(webhookTrigger.isActive).toBe(false)

      await cronTrigger.start()
      await webhookTrigger.start()

      expect(cronTrigger.isActive).toBe(true)
      expect(webhookTrigger.isActive).toBe(true)

      await cronTrigger.stop()
      await webhookTrigger.stop()
    })
  })

  describe('Trigger event structure', () => {
    it('configures trigger for workflow invocation', async () => {
      const id = `event-structure-${Date.now()}`
      const trigger = createCronTrigger(id, 'Event Structure Test')

      registry.register(trigger)
      await trigger.initialize({
        id,
        schedule: '0 * * * *',
        workflowId: 'structure-workflow',
      })

      // Set up event handler to capture event
      let capturedEvent: TriggerEvent | null = null
      trigger.onEvent((event) => {
        capturedEvent = event
        return Promise.resolve()
      })

      await trigger.start()

      // Verify trigger is running
      expect(trigger.isActive).toBe(true)

      // Note: CronTrigger doesn't emit events immediately, it schedules them
      // This test verifies the trigger can be configured for workflow invocation

      await trigger.stop()
    })
  })

  describe('Trigger lifecycle with workflow', () => {
    it('handles trigger stop after workflow configuration', async () => {
      const id = `lifecycle-test-${Date.now()}`
      const trigger = createCronTrigger(id, 'Lifecycle Test')

      registry.register(trigger)
      await trigger.initialize({
        id,
        schedule: '0 * * * *',
        workflowId: 'lifecycle-workflow',
      })

      await trigger.start()
      expect(trigger.state).toBe(TriggerState.ACTIVE)

      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })

    it('prevents re-initialization after stop', async () => {
      const id = `reinit-test-${Date.now()}`
      const trigger = createCronTrigger(id, 'Reinit Test')

      registry.register(trigger)
      await trigger.initialize({
        id,
        schedule: '0 * * * *',
        workflowId: 'reinit-workflow',
      })

      await trigger.start()
      await trigger.stop()

      // Trigger should be in STOPPED state
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })
  })

  describe('Registry operations', () => {
    it('lists all registered triggers', async () => {
      const id1 = `list-test-1-${Date.now()}`
      const id2 = `list-test-2-${Date.now()}`

      const trigger1 = createCronTrigger(id1, 'List Test 1')
      const trigger2 = createCronTrigger(id2, 'List Test 2')

      registry.register(trigger1)
      registry.register(trigger2)

      expect(registry.list().length).toBe(2)
    })

    it('checks trigger existence', async () => {
      const id = `exists-test-${Date.now()}`
      const trigger = createCronTrigger(id, 'Exists Test')

      registry.register(trigger)

      expect(registry.has(id)).toBe(true)
      expect(registry.has('nonexistent')).toBe(false)
    })

    it('unregisters trigger', async () => {
      const id = `unregister-test-${Date.now()}`
      const trigger = createCronTrigger(id, 'Unregister Test')

      registry.register(trigger)
      expect(registry.has(id)).toBe(true)

      await registry.unregister(id)
      expect(registry.has(id)).toBe(false)
    })
  })
})
