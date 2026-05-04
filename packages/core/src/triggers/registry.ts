/**
 * Registry for managing trigger plugins
 */

import type { TriggerPluginBase } from './base.js'
import type {
  TriggerConfig,
  TriggerEvent,
  TriggerEventHandler,
  TriggerHealthStatus,
  TriggerType,
} from './types.js'

/**
 * Trigger event handler wrapper
 */
interface TriggerHandlerEntry {
  handler: TriggerEventHandler
  triggerTypes?: TriggerType[] // If specified, only handle these trigger types
}

/**
 * Registry for managing trigger plugins
 */
export class TriggerRegistry {
  /** Registered triggers */
  private readonly triggers: Map<string, TriggerPluginBase> = new Map()

  /** Event handlers */
  private readonly eventHandlers: TriggerHandlerEntry[] = []

  /**
   * Register a trigger plugin
   */
  register(trigger: TriggerPluginBase): void {
    if (this.triggers.has(trigger.id)) {
      throw new Error(`Trigger with id '${trigger.id}' is already registered`)
    }

    this.triggers.set(trigger.id, trigger)
  }

  /**
   * Unregister a trigger plugin
   */
  async unregister(id: string): Promise<void> {
    const trigger = this.triggers.get(id)
    if (!trigger) {
      return
    }

    if (trigger.isActive) {
      await trigger.stop()
    }

    this.triggers.delete(id)
  }

  /**
   * Get a trigger by ID
   */
  get(id: string): TriggerPluginBase | undefined {
    return this.triggers.get(id)
  }

  /**
   * Check if a trigger exists
   */
  has(id: string): boolean {
    return this.triggers.has(id)
  }

  /**
   * List all registered triggers
   */
  list(): TriggerPluginBase[] {
    return Array.from(this.triggers.values())
  }

  /**
   * List enabled triggers
   */
  listEnabled(): TriggerPluginBase[] {
    return this.list().filter((t) => t.enabled)
  }

  /**
   * List triggers by type
   */
  listByType(type: TriggerType): TriggerPluginBase[] {
    return this.list().filter((t) => t.getTriggerType() === type)
  }

  /**
   * Initialize all registered triggers
   */
  async initializeAll(configs: Record<string, TriggerConfig>): Promise<void> {
    const promises = this.list().map(async (trigger) => {
      const config = configs[trigger.id]
      if (config) {
        try {
          await trigger.initialize(config)
        } catch (error) {
          console.error(`Failed to initialize trigger '${trigger.id}':`, error)
        }
      }
    })

    await Promise.all(promises)
  }

  /**
   * Start all enabled triggers
   */
  async startAll(): Promise<void> {
    const promises = this.listEnabled().map(async (trigger) => {
      try {
        await trigger.start()
      } catch (error) {
        console.error(`Failed to start trigger '${trigger.id}':`, error)
      }
    })

    await Promise.all(promises)
  }

  /**
   * Stop all triggers
   */
  async stopAll(): Promise<void> {
    const triggers = this.list()

    // Stop in reverse order of registration
    const promises = triggers.reverse().map(async (trigger) => {
      try {
        await trigger.stop()
      } catch (error) {
        console.error(`Failed to stop trigger '${trigger.id}':`, error)
      }
    })

    await Promise.all(promises)
  }

  /**
   * Shutdown all triggers and clear registry
   */
  async shutdown(): Promise<void> {
    await this.stopAll()
    this.triggers.clear()
    this.eventHandlers.length = 0
  }

  /**
   * Add an event handler
   */
  onEvent(handler: TriggerEventHandler, triggerTypes?: TriggerType[]): void {
    const entry: TriggerHandlerEntry = { handler }
    if (triggerTypes !== undefined) {
      entry.triggerTypes = triggerTypes
    }
    this.eventHandlers.push(entry)
  }

  /**
   * Remove an event handler
   */
  removeHandler(handler: TriggerEventHandler): void {
    const index = this.eventHandlers.findIndex((h) => h.handler === handler)
    if (index !== -1) {
      this.eventHandlers.splice(index, 1)
    }
  }

  /**
   * Dispatch an event to all matching handlers
   */
  async dispatchEvent(event: TriggerEvent): Promise<void> {
    const promises = this.eventHandlers.map(async ({ handler, triggerTypes }) => {
      // Filter by trigger type if specified
      if (triggerTypes && !triggerTypes.includes(event.triggerType)) {
        return
      }

      try {
        await handler(event)
      } catch (error) {
        console.error(`Event handler error for ${event.eventId}:`, error)
      }
    })

    await Promise.all(promises)
  }

  /**
   * Check health of all triggers
   */
  async checkAllHealth(): Promise<Record<string, TriggerHealthStatus>> {
    const results: Record<string, TriggerHealthStatus> = {}

    const promises = this.list().map(async (trigger) => {
      try {
        results[trigger.id] = await trigger.healthCheck()
      } catch (error) {
        results[trigger.id] = {
          healthy: false,
          status: 'check-failed',
          error: error instanceof Error ? error.message : String(error),
          lastCheck: new Date(),
        }
      }
    })

    await Promise.all(promises)
    return results
  }

  /**
   * Get healthy triggers
   */
  async getHealthyTriggers(): Promise<TriggerPluginBase[]> {
    const health = await this.checkAllHealth()
    return this.list().filter((t) => health[t.id]?.healthy === true)
  }
}
