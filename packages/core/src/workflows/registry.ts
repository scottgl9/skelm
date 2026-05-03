/**
 * Registry for managing workflow plugins
 */

import type { WorkflowPluginBase } from './base.js'
import type { WorkflowConfig, WorkflowHealthStatus } from './types.js'

/**
 * Registry for managing workflow plugins
 */
export class WorkflowRegistry {
  /** Registered workflows */
  private readonly workflows: Map<string, WorkflowPluginBase> = new Map()
  
  /**
   * Register a workflow plugin
   */
  register(workflow: WorkflowPluginBase): void {
    if (this.workflows.has(workflow.id)) {
      throw new Error(`Workflow with id '${workflow.id}' is already registered`)
    }
    
    this.workflows.set(workflow.id, workflow)
  }
  
  /**
   * Unregister a workflow plugin
   */
  async unregister(id: string): Promise<void> {
    const workflow = this.workflows.get(id)
    if (!workflow) {
      return
    }
    
    if (workflow.isActive) {
      await workflow.stop()
    }
    
    this.workflows.delete(id)
  }
  
  /**
   * Get a workflow by ID
   */
  get(id: string): WorkflowPluginBase | undefined {
    return this.workflows.get(id)
  }
  
  /**
   * Check if a workflow exists
   */
  has(id: string): boolean {
    return this.workflows.has(id)
  }
  
  /**
   * List all registered workflows
   */
  list(): WorkflowPluginBase[] {
    return Array.from(this.workflows.values())
  }
  
  /**
   * List enabled workflows
   */
  listEnabled(): WorkflowPluginBase[] {
    return this.list().filter((w) => w.isEnabled)
  }
  
  /**
   * Initialize all registered workflows
   */
  async initializeAll(configs: Record<string, WorkflowConfig>): Promise<void> {
    const promises = this.list().map(async (workflow) => {
      const config = configs[workflow.id]
      if (config) {
        try {
          await workflow.initialize(config)
        } catch (error) {
          console.error(`Failed to initialize workflow '${workflow.id}':`, error)
        }
      }
    })
    
    await Promise.all(promises)
  }
  
  /**
   * Start all enabled workflows
   */
  async startAll(): Promise<void> {
    const promises = this.listEnabled().map(async (workflow) => {
      try {
        await workflow.start()
      } catch (error) {
        console.error(`Failed to start workflow '${workflow.id}':`, error)
      }
    })
    
    await Promise.all(promises)
  }
  
  /**
   * Stop all workflows
   */
  async stopAll(): Promise<void> {
    const workflows = this.list()
    
    // Stop in reverse order of registration
    const promises = workflows.reverse().map(async (workflow) => {
      try {
        await workflow.stop()
      } catch (error) {
        console.error(`Failed to stop workflow '${workflow.id}':`, error)
      }
    })
    
    await Promise.all(promises)
  }
  
  /**
   * Shutdown all workflows and clear registry
   */
  async shutdown(): Promise<void> {
    await this.stopAll()
    this.workflows.clear()
  }
  
  /**
   * Check health of all workflows
   */
  async checkAllHealth(): Promise<Record<string, WorkflowHealthStatus>> {
    const results: Record<string, WorkflowHealthStatus> = {}
    
    const promises = this.list().map(async (workflow) => {
      try {
        results[workflow.id] = await workflow.healthCheck()
      } catch (error) {
        results[workflow.id] = {
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
   * Get healthy workflows
   */
  async getHealthyWorkflows(): Promise<WorkflowPluginBase[]> {
    const health = await this.checkAllHealth()
    return this.list().filter((w) => health[w.id]?.healthy === true)
  }
}
