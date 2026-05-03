import { describe, it, expect, vi } from 'vitest'
import { WebhookTrigger, createWebhookTrigger } from '../../src/triggers/webhook.js'
import { TriggerState } from '../../src/triggers/base.js'
import type { TriggerConfig } from '../../src/triggers/types.js'

describe('WebhookTrigger', () => {
  let portCounter = 3010
  
  describe('getTriggerType', () => {
    it('returns webhook type', () => {
      const trigger = createWebhookTrigger('webhook-type', 'Test Webhook')
      expect(trigger.getTriggerType()).toBe('webhook')
    })
  })
  
  describe('initialization', () => {
    it('initializes with valid config', async () => {
      const id = `webhook-valid-${Date.now()}`
      const trigger = createWebhookTrigger(id, 'Valid Webhook')
      await trigger.initialize({
        id,
        path: '/webhook/test',
        port: ++portCounter,
      })
      
      expect(trigger.isInitialized).toBe(true)
      expect(trigger.state).toBe(TriggerState.INITIALIZED)
      
      await trigger.stop().catch(() => {})
    })
    
    it('initializes without path (uses default)', async () => {
      const id = `webhook-nopath-${Date.now()}`
      const trigger = createWebhookTrigger(id, 'No Path Webhook')
      await trigger.initialize({
        id,
        port: ++portCounter,
      } as unknown as TriggerConfig)
      
      expect(trigger.isInitialized).toBe(true)
      
      await trigger.stop().catch(() => {})
    })
    
    it('initializes with custom port', async () => {
      const id = `webhook-port-${Date.now()}`
      const trigger = createWebhookTrigger(id, 'Port Webhook')
      await trigger.initialize({
        id,
        path: '/test',
        port: ++portCounter,
      })
      
      expect(trigger.isInitialized).toBe(true)
      
      await trigger.stop().catch(() => {})
    })
  })
  
  describe('start/stop', () => {
    it('starts and listens for webhook', async () => {
      const handler = vi.fn()
      const id = `webhook-start-${Date.now()}`
      const trigger = createWebhookTrigger(id, 'Start Webhook')
      await trigger.initialize({
        id,
        path: '/test',
        port: ++portCounter,
      })
      
      trigger.onEvent(handler)
      await trigger.start()
      
      expect(trigger.isActive).toBe(true)
      
      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })
    
    it('stops server on stop', async () => {
      const id = `webhook-stop-${Date.now()}`
      const trigger = createWebhookTrigger(id, 'Stop Webhook')
      await trigger.initialize({
        id,
        path: '/test',
        port: ++portCounter,
      })
      
      await trigger.start()
      
      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })
  })
  
  describe('health check', () => {
    it('returns healthy when running', async () => {
      const id = `webhook-health-${Date.now()}`
      const trigger = createWebhookTrigger(id, 'Health Webhook')
      await trigger.initialize({
        id,
        path: '/test',
        port: ++portCounter,
      })
      
      await trigger.start()
      const health = await trigger.healthCheck()
      
      expect(health.healthy).toBe(true)
      expect(health.status).toBe('listening')
      
      await trigger.stop()
    })
    
    it('includes path in details', async () => {
      const id = `webhook-details-${Date.now()}`
      const trigger = createWebhookTrigger(id, 'Details Webhook')
      await trigger.initialize({
        id,
        path: '/custom/path',
        port: ++portCounter,
      })
      
      await trigger.start()
      const health = await trigger.healthCheck()
      
      expect(health.details).toMatchObject({
        path: '/custom/path',
      })
      
      await trigger.stop()
    })
  })
  
  describe('factory function', () => {
    it('creates WebhookTrigger instance', () => {
      const trigger = createWebhookTrigger('factory-test', 'Factory Test')
      
      expect(trigger).toBeInstanceOf(WebhookTrigger)
      expect(trigger.id).toBe('factory-test')
      expect(trigger.name).toBe('Factory Test')
      expect(trigger.getTriggerType()).toBe('webhook')
    })
  })
})
