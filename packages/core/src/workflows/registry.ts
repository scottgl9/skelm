/**
 * Registry for managing workflow plugins
 */

import { RegistryError, toErrorMessage } from '../errors.js'
import type { WorkflowPluginBase } from './base.js'
import type { DiscoveredWorkflowPackage } from './packages.js'
import { resolveWorkflowPackagePath } from './packages.js'
import type { WorkflowConfig, WorkflowHealthStatus } from './types.js'

/**
 * Registry for managing workflow plugins
 */
export class WorkflowRegistry {
  /** Registered workflows */
  private readonly workflows: Map<string, WorkflowPluginBase> = new Map()
  /** Registered installable workflow packages */
  private readonly workflowPackages: Map<string, DiscoveredWorkflowPackage> = new Map()

  /**
   * Register a workflow plugin
   */
  register(workflow: WorkflowPluginBase): void {
    if (this.workflows.has(workflow.id)) {
      throw new RegistryError(
        `Workflow with id '${workflow.id}' is already registered`,
        'workflow',
        workflow.id,
      )
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
   * Register an explicitly discovered installable workflow package.
   */
  registerPackage(pkg: DiscoveredWorkflowPackage): void {
    if (this.workflowPackages.has(pkg.id)) {
      throw new RegistryError(
        `Workflow package with id '${pkg.id}' is already registered`,
        'workflowPackage',
        pkg.id,
      )
    }

    const registeredWorkflowIds = new Set(
      this.listPackages().flatMap((registered) =>
        registered.workflows.map((workflow) => workflow.id),
      ),
    )
    for (const workflow of pkg.workflows) {
      if (registeredWorkflowIds.has(workflow.id)) {
        throw new RegistryError(
          `Workflow package '${pkg.id}' declares duplicate workflow id '${workflow.id}'`,
          'workflowPackage',
          workflow.id,
        )
      }
    }

    this.workflowPackages.set(pkg.id, pkg)
  }

  /**
   * Get an installed workflow package by package id.
   */
  getPackage(id: string): DiscoveredWorkflowPackage | undefined {
    return this.workflowPackages.get(id)
  }

  /**
   * List installed workflow packages in registration order.
   */
  listPackages(): DiscoveredWorkflowPackage[] {
    return Array.from(this.workflowPackages.values())
  }

  /**
   * Resolve a package-relative path under a registered workflow package root.
   */
  resolvePackagePath(packageId: string, packageRelativePath: string): string {
    const pkg = this.workflowPackages.get(packageId)
    if (!pkg) {
      throw new RegistryError(
        `Workflow package with id '${packageId}' is not registered`,
        'workflowPackage',
        packageId,
      )
    }
    return resolveWorkflowPackagePath(pkg, packageRelativePath)
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
          console.error(`Failed to initialize workflow '${workflow.id}': ${toErrorMessage(error)}`)
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
        console.error(`Failed to start workflow '${workflow.id}': ${toErrorMessage(error)}`)
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
        console.error(`Failed to stop workflow '${workflow.id}': ${toErrorMessage(error)}`)
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
    this.workflowPackages.clear()
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
          error: toErrorMessage(error),
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
