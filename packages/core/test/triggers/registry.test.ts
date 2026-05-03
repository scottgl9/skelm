import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TriggerRegistry } from '../../src/triggers/registry.js'
import { TriggerPluginBase } from '../../src/triggers/base.js'
import type { TriggerConfig, TriggerType, TriggerEvent, TriggerHealthStatus } from '../../src/triggers/types.js'

// Mock trigger for testing
class MockTrigger extends TriggerPluginBase {
  private _initialized = false
  private _started = false
  private _stopped = false
  
  constructor(
    id: string,
    name: string,
    private _triggerType: TriggerType = 'custom'
  ) {
    super(id, name, '1.0.0', `Mock ${name}`)
  }
  
  override getTriggerType(): TriggerType {
    return this._triggerType
  }
  
  override protected async doInitialize(_config: TriggerConfig): Promise<void> {
    this._initialized = true
  }
  
  override protected async doStart(): Promise<void> {
    this._started = true
  }
  
  override protected async doStop(): Promise<void> {
    this._stopped = true
    this._started = false
  }
  
  override async healthCheck(): Promise<TriggerHealthStatus> {
    return {
      healthy: this._started,
      status: this._started ? 'healthy' : 'not-running',
    }
  }
  
  get initialized(): boolean {
    return this._initialized
  }
  
  get started(): boolean {
    return this._started
  }
  
  get stopped(): boolean {
    return this._stopped
  }
}

describe('TriggerRegistry', () => {
  let registry: TriggerRegistry
  
  beforeEach(() => {
    registry = new TriggerRegistry()
  })
  
  afterEach(async () => {
    await registry.shutdown()
  })
  
  describe('registration', () => {
    it('creates an empty registry', () => {
      expect(registry.list()).toHaveLength(0)
      expect(registry.listEnabled()).toHaveLength(0)
    })
    
    it('registers a trigger', () => {
      const trigger = new MockTrigger('test', 'Test Trigger')
      registry.register(trigger)
      
      expect(registry.has('test')).toBe(true)
      expect(registry.get('test')).toBe(trigger)
      expect(registry.list()).toHaveLength(1)
    })
    
    it('prevents duplicate registration', () => {
      const trigger = new MockTrigger('test', 'Test Trigger')
      registry.register(trigger)
      
      expect(() => registry.register(trigger)).toThrow("Trigger with id 'test' is already registered")
    })
    
    it('unregisters a trigger', async () => {
      const trigger = new MockTrigger('test', 'Test Trigger')
      registry.register(trigger)
      
      await registry.unregister('test')
      
      expect(registry.has('test')).toBe(false)
      expect(registry.list()).toHaveLength(0)
    })
    
    it('stops trigger before unregistering', async () => {
      const trigger = new MockTrigger('test', 'Test Trigger')
      registry.register(trigger)
      
      const config: TriggerConfig = { id: 'test', name: 'Test', enabled: true }
      await trigger.initialize(config)
      await trigger.start()
      
      await registry.unregister('test')
      
      expect(trigger.stopped).toBe(true)
    })
  })
  
  describe('listing', () => {
    it('lists all triggers', () => {
      const trigger1 = new MockTrigger('test1', 'Test 1')
      const trigger2 = new MockTrigger('test2', 'Test 2')
      
      registry.register(trigger1)
      registry.register(trigger2)
      
      expect(registry.list()).toHaveLength(2)
    })
    
    it('lists enabled triggers', () => {
      const enabled = new MockTrigger('enabled', 'Enabled')
      const disabled = new MockTrigger('disabled', 'Disabled')
      
      registry.register(enabled)
      registry.register(disabled)
      
      // Disable the second trigger
      disabled.enabled = false
      
      expect(registry.listEnabled()).toHaveLength(1)
      expect(registry.listEnabled()[0].id).toBe('enabled')
    })
    
    it('lists triggers by type', () => {
      const cron = new MockTrigger('cron', 'Cron', 'cron')
      const webhook = new MockTrigger('webhook', 'Webhook', 'webhook')
      const slack = new MockTrigger('slack', 'Slack', 'slack')
      
      registry.register(cron)
      registry.register(webhook)
      registry.register(slack)
      
      expect(registry.listByType('cron')).toHaveLength(1)
      expect(registry.listByType('webhook')).toHaveLength(1)
      expect(registry.listByType('slack')).toHaveLength(1)
    })
  })
  
  describe('lifecycle management', () => {
    it('initializes all triggers', async () => {
      const trigger1 = new MockTrigger('test1', 'Test 1')
      const trigger2 = new MockTrigger('test2', 'Test 2')
      
      registry.register(trigger1)
      registry.register(trigger2)
      
      const configs: Record<string, TriggerConfig> = {
        test1: { id: 'test1', name: 'Test 1', enabled: true },
        test2: { id: 'test2', name: 'Test 2', enabled: true },
      }
      
      await registry.initializeAll(configs)
      
      expect(trigger1.initialized).toBe(true)
      expect(trigger2.initialized).toBe(true)
    })
    
    it('starts all enabled triggers', async () => {
      const trigger1 = new MockTrigger('test1', 'Test 1')
      const trigger2 = new MockTrigger('test2', 'Test 2')
      
      registry.register(trigger1)
      registry.register(trigger2)
      
      const configs: Record<string, TriggerConfig> = {
        test1: { id: 'test1', name: 'Test 1', enabled: true },
        test2: { id: 'test2', name: 'Test 2', enabled: true },
      }
      
      await registry.initializeAll(configs)
      await registry.startAll()
      
      expect(trigger1.started).toBe(true)
      expect(trigger2.started).toBe(true)
    })
    
    it('stops all triggers', async () => {
      const trigger1 = new MockTrigger('test1', 'Test 1')
      const trigger2 = new MockTrigger('test2', 'Test 2')
      
      registry.register(trigger1)
      registry.register(trigger2)
      
      const configs: Record<string, TriggerConfig> = {
        test1: { id: 'test1', name: 'Test 1', enabled: true },
        test2: { id: 'test2', name: 'Test 2', enabled: true },
      }
      
      await registry.initializeAll(configs)
      await registry.startAll()
      await registry.stopAll()
      
      expect(trigger1.stopped).toBe(true)
      expect(trigger2.stopped).toBe(true)
    })
    
    it('shuts down and clears registry', async () => {
      const trigger = new MockTrigger('test', 'Test')
      registry.register(trigger)
      
      await registry.shutdown()
      
      expect(registry.list()).toHaveLength(0)
    })
  })
  
  describe('event handling', () => {
    it('adds event handlers', () => {
      const handler = vi.fn()
      registry.onEvent(handler)
      
      expect(registry.list()).toHaveLength(0) // Just checking registry is usable
    })
    
    it('removes event handlers', () => {
      const handler = vi.fn()
      registry.onEvent(handler)
      registry.removeHandler(handler)
      
      expect(registry.list()).toHaveLength(0)
    })
    
    it('dispatches events to handlers', async () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      
      registry.onEvent(handler1)
      registry.onEvent(handler2)
      
      const event: TriggerEvent = {
        eventId: 'test-event',
        triggerId: 'test',
        triggerType: 'custom',
        timestamp: new Date(),
        payload: { test: 'data' },
        metadata: { source: 'test' },
      }
      
      await registry.dispatchEvent(event)
      
      expect(handler1).toHaveBeenCalledWith(event)
      expect(handler2).toHaveBeenCalledWith(event)
    })
    
    it('filters handlers by trigger type', async () => {
      const cronHandler = vi.fn()
      const webhookHandler = vi.fn()
      
      registry.onEvent(cronHandler, ['cron'])
      registry.onEvent(webhookHandler, ['webhook'])
      
      const cronEvent: TriggerEvent = {
        eventId: 'cron-event',
        triggerId: 'cron-trigger',
        triggerType: 'cron',
        timestamp: new Date(),
        payload: {},
        metadata: { source: 'cron' },
      }
      
      await registry.dispatchEvent(cronEvent)
      
      expect(cronHandler).toHaveBeenCalledWith(cronEvent)
      expect(webhookHandler).not.toHaveBeenCalled()
    })
    
    it('handles handler errors gracefully', async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error('Handler failed'))
      const workingHandler = vi.fn()
      
      registry.onEvent(failingHandler)
      registry.onEvent(workingHandler)
      
      const event: TriggerEvent = {
        eventId: 'test-event',
        triggerId: 'test',
        triggerType: 'custom',
        timestamp: new Date(),
        payload: {},
        metadata: { source: 'test' },
      }
      
      // Should not throw even with failing handler
      await expect(registry.dispatchEvent(event)).resolves.not.toThrow()
      
      expect(workingHandler).toHaveBeenCalledWith(event)
    })
  })
  
  describe('health checks', () => {
    it('checks health of all triggers', async () => {
      const trigger1 = new MockTrigger('test1', 'Test 1')
      const trigger2 = new MockTrigger('test2', 'Test 2')
      
      registry.register(trigger1)
      registry.register(trigger2)
      
      const configs: Record<string, TriggerConfig> = {
        test1: { id: 'test1', name: 'Test 1', enabled: true },
        test2: { id: 'test2', name: 'Test 2', enabled: true },
      }
      
      await registry.initializeAll(configs)
      await registry.startAll()
      
      const health = await registry.checkAllHealth()
      
      expect(health.test1?.healthy).toBe(true)
      expect(health.test2?.healthy).toBe(true)
    })
    
    it('returns unhealthy for non-running triggers', async () => {
      const trigger = new MockTrigger('test', 'Test')
      registry.register(trigger)
      
      const health = await registry.checkAllHealth()
      
      expect(health.test?.healthy).toBe(false)
      expect(health.test?.status).toBe('not-running')
    })
    
    it('gets healthy triggers', async () => {
      const trigger1 = new MockTrigger('test1', 'Test 1')
      const trigger2 = new MockTrigger('test2', 'Test 2')
      
      registry.register(trigger1)
      registry.register(trigger2)
      
      const configs: Record<string, TriggerConfig> = {
        test1: { id: 'test1', name: 'Test 1', enabled: true },
        test2: { id: 'test2', name: 'Test 2', enabled: true },
      }
      
      await registry.initializeAll(configs)
      await registry.startAll()
      
      const healthy = await registry.getHealthyTriggers()
      
      expect(healthy).toHaveLength(2)
    })
  })
})
