/**
 * Custom trigger implementation
 * 
 * Allows users to register custom trigger logic via handler functions
 * Perfect for file watchers, DB listeners, WebSocket subscriptions, etc.
 */

import { TriggerPluginBase, TriggerError } from './base.js'
import type { TriggerConfig, TriggerType, TriggerEvent, TriggerHealthStatus } from './types.js'

/**
 * Custom trigger configuration
 */
export interface CustomTriggerConfig extends TriggerConfig {
  /** Handler function that implements custom trigger logic */
  handler: () => Promise<void>
  /** Optional custom health check function */
  healthCheck?: () => Promise<boolean>
  /** Optional state storage for the handler */
  state?: Record<string, unknown>
}

/**
 * Custom trigger plugin
 */
export class CustomTrigger extends TriggerPluginBase {
  private isRunning: boolean = false
  
  constructor(id: string, name: string, description?: string) {
    super(id, name, '1.0.0', description)
  }
  
  override getTriggerType(): TriggerType {
    return 'custom'
  }
  
  override async doInitialize(config: CustomTriggerConfig): Promise<void> {
    if (!config.handler || typeof config.handler !== 'function') {
      throw new TriggerError('Custom trigger requires a handler function')
    }
    
    // Call parent initialize to set up base config
    await super.initialize(config)
    
    this.logger.info(`Initialized custom trigger: ${this.name}`)
  }
  
  override async doStart(): Promise<void> {
    const config = this.config as CustomTriggerConfig | null
    if (!config) {
      throw new TriggerError('Custom trigger not initialized')
    }
    
    this.isRunning = true
    
    try {
      await config.handler()
      this.logger.info('Custom trigger handler executed')
    } catch (error) {
      this.logger.error(`Custom trigger handler error: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }
  
  override async doStop(): Promise<void> {
    this.isRunning = false
    this.logger.info('Custom trigger stopped')
  }
  
  override async doHealthCheck(): Promise<TriggerHealthStatus> {
    const config = this.config as CustomTriggerConfig | null
    if (config?.healthCheck) {
      const healthy = await config.healthCheck()
      return {
        healthy,
        status: healthy ? 'healthy' : 'unhealthy',
        details: {
          customCheck: true,
        },
      }
    }
    
    return {
      healthy: this.isRunning,
      status: this.isRunning ? 'running' : 'stopped',
      details: {},
    }
  }
  
  /**
   * Get custom state storage
   */
  getState<T = unknown>(key: string): T | undefined {
    const config = this.config as CustomTriggerConfig | null
    return config?.state?.[key] as T | undefined
  }
  
  /**
   * Set custom state storage
   */
  setState(key: string, value: unknown): void {
    const config = this.config as CustomTriggerConfig | null
    if (!config?.state) {
      // Note: state management happens in the config passed to initialize
      this.logger.warn('Cannot set state - trigger not initialized or state not configured')
      return
    }
    config.state[key] = value
  }
  
  /**
   * Emit an event from the custom trigger
   */
  override async emitEvent(payload: unknown, metadata?: Record<string, unknown>): Promise<void> {
    const event: TriggerEvent = {
      eventId: `custom-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      triggerId: this.id,
      triggerType: 'custom',
      timestamp: new Date(),
      payload,
      metadata: {
        ...metadata,
        source: 'custom',
      },
    }
    
    await super.emitEvent(event)
  }
}

/**
 * Create a custom trigger
 */
export function createCustomTrigger(id: string, name: string, description?: string): CustomTrigger {
  return new CustomTrigger(id, name, description)
}
