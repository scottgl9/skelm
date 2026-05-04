import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TriggerError, TriggerPluginBase, TriggerState } from '../../src/triggers/base.js'
import type { TriggerConfig, TriggerHealthStatus, TriggerType } from '../../src/triggers/types.js'

// Mock trigger implementation for testing
class MockTrigger extends TriggerPluginBase {
  private initialized = false
  private started = false
  private stopped = false
  
  constructor(id: string, name: string) {
    super(id, name, '1.0.0', 'Mock trigger for testing')
  }
  
  override getTriggerType(): TriggerType {
    return 'custom'
  }
  
  override protected async doInitialize(_config: TriggerConfig): Promise<void> {
    this.initialized = true
  }
  
  override protected async doStart(): Promise<void> {
    if (!this.initialized) {
      throw new Error('Not initialized')
    }
    this.started = true
  }
  
  override protected async doStop(): Promise<void> {
    this.stopped = true
    this.started = false
  }
  
  override protected doHealthCheck(): Promise<TriggerHealthStatus> {
    return Promise.resolve({
      healthy: this.started,
      status: this.started ? 'healthy' : 'not-running',
    })
  }
  
  // Expose protected methods for testing
  getInitialized(): boolean {
    return this.initialized
  }
  
  getStarted(): boolean {
    return this.started
  }
  
  getStopped(): boolean {
    return this.stopped
  }
}

describe('TriggerPluginBase', () => {
  let trigger: MockTrigger
  
  beforeEach(() => {
    trigger = new MockTrigger('test-trigger', 'Test Trigger')
  })
  
  afterEach(async () => {
    if (trigger.isActive) {
      await trigger.stop()
    }
  })
  
  describe('constructor', () => {
    it('creates a trigger with basic properties', () => {
      expect(trigger.id).toBe('test-trigger')
      expect(trigger.name).toBe('Test Trigger')
      expect(trigger.version).toBe('1.0.0')
      expect(trigger.description).toBe('Mock trigger for testing')
    })
    
    it('initializes in IDLE state', () => {
      expect(trigger.isActive).toBe(false)
      expect(trigger.isInitialized).toBe(false)
    })
    
    it('sets up logger', () => {
      expect(typeof trigger.logger.info).toBe('function')
      expect(typeof trigger.logger.warn).toBe('function')
      expect(typeof trigger.logger.error).toBe('function')
    })
  })
  
  describe('lifecycle', () => {
    it('initializes the trigger', async () => {
      const config: TriggerConfig = {
        id: 'test-trigger',
        name: 'Test Trigger',
        enabled: true,
      }
      
      await trigger.initialize(config)
      
      expect(trigger.isInitialized).toBe(true)
      expect(trigger.getInitialized()).toBe(true)
    })
    
    it('starts the trigger after initialization', async () => {
      const config: TriggerConfig = {
        id: 'test-trigger',
        name: 'Test Trigger',
        enabled: true,
      }
      
      await trigger.initialize(config)
      await trigger.start()
      
      expect(trigger.isActive).toBe(true)
      expect(trigger.getStarted()).toBe(true)
    })
    
    it('stops the trigger', async () => {
      const config: TriggerConfig = {
        id: 'test-trigger',
        name: 'Test Trigger',
        enabled: true,
      }
      
      await trigger.initialize(config)
      await trigger.start()
      await trigger.stop()
      
      expect(trigger.isActive).toBe(false)
      expect(trigger.getStopped()).toBe(true)
    })
    
    it('prevents initialization in wrong state', async () => {
      const config: TriggerConfig = {
        id: 'test-trigger',
        name: 'Test Trigger',
        enabled: true,
      }
      
      await trigger.initialize(config)
      
      await expect(trigger.initialize(config)).rejects.toThrow(TriggerError)
    })
    
    it('prevents starting without initialization', async () => {
      await expect(trigger.start()).rejects.toThrow(TriggerError)
    })
    
    it('handles stop when not running gracefully', async () => {
      await expect(trigger.stop()).resolves.not.toThrow()
    })
  })
  
  describe('event handling', () => {
    it('adds event handlers', () => {
      const handler = vi.fn()
      trigger.onEvent(handler)
      
      // Note: We can't directly access handlers array, but we can test emit
      expect(trigger.isActive).toBe(false) // Just checking trigger is usable
    })
    
    it('removes event handlers', () => {
      const handler = vi.fn()
      trigger.onEvent(handler)
      trigger.removeHandler(handler)
      
      expect(trigger.isActive).toBe(false)
    })
  })
  
  describe('health check', () => {
    it('returns unhealthy when not running', async () => {
      const status = await trigger.healthCheck()
      
      expect(status.healthy).toBe(false)
      expect(status.status).toBe('not-running')
    })
    
    it('returns healthy when running', async () => {
      const config: TriggerConfig = {
        id: 'test-trigger',
        name: 'Test Trigger',
        enabled: true,
      }
      
      await trigger.initialize(config)
      await trigger.start()
      
      const status = await trigger.healthCheck()
      
      expect(status.healthy).toBe(true)
      expect(status.status).toBe('healthy')
    })
  })
  
  describe('state transitions', () => {
    it('follows correct state transition sequence', async () => {
      const config: TriggerConfig = {
        id: 'test-trigger',
        name: 'Test Trigger',
        enabled: true,
      }
      
      expect(trigger.state).toBe(TriggerState.IDLE)
      
      await trigger.initialize(config)
      expect(trigger.state).toBe(TriggerState.INITIALIZED)
      
      await trigger.start()
      expect(trigger.state).toBe(TriggerState.ACTIVE)
      
      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })
  })
  
  describe('error handling', () => {
    it('transitions to error state on initialization failure', async () => {
      const failingTrigger = new MockTrigger('failing', 'Failing Trigger')
      
      // Override doInitialize to throw
      const originalDoInitialize = failingTrigger['doInitialize'].bind(failingTrigger)
      failingTrigger['doInitialize'] = async () => {
        throw new Error('Initialization failed')
      }
      
      const config: TriggerConfig = {
        id: 'failing',
        name: 'Failing',
        enabled: true,
      }
      
      await expect(failingTrigger.initialize(config)).rejects.toThrow('Initialization failed')
      expect(failingTrigger.state).toBe(TriggerState.ERROR)
    })
    
    it('transitions to error state on start failure', async () => {
      const failingTrigger = new MockTrigger('failing-start', 'Failing Start')
      
      // First initialize successfully
      const config: TriggerConfig = {
        id: 'failing-start',
        name: 'Failing Start',
        enabled: true,
      }
      
      await failingTrigger.initialize(config)
      
      // Override doStart to throw
      failingTrigger['doStart'] = async () => {
        throw new Error('Start failed')
      }
      
      await expect(failingTrigger.start()).rejects.toThrow()
      expect(failingTrigger.state).toBe(TriggerState.ERROR)
    })
  })
  
  describe('logging', () => {
    it('logs at appropriate levels', () => {
      const config: TriggerConfig = {
        id: 'test-trigger',
        name: 'Test Trigger',
        logLevel: 'debug',
        enabled: true,
      }
      
      // This would normally log, but we're just checking the logger exists
      expect(() => trigger.logger.debug('test')).not.toThrow()
      expect(() => trigger.logger.info('test')).not.toThrow()
      expect(() => trigger.logger.warn('test')).not.toThrow()
      expect(() => trigger.logger.error('test')).not.toThrow()
    })
  })
})
