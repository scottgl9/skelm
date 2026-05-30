/**
 * Plugin system for skelm
 *
 * Supports two plugin types:
 * 1. Model plugins - LLM endpoints (openai, anthropic, vllm, sglang, ollama, etc.)
 * 2. Agent plugins - coding agent SDKs (acp, opencode, pi, github-copilot, etc.)
 * 3. Workflow plugins - integrations (slack, matrix, discord, etc.)
 */

import type { SkelmBackend } from './backend.js'
import type { SkelmConfig } from './config.js'

/**
 * Plugin lifecycle stages
 */
export type PluginLifecycle =
  | 'loading'
  | 'loaded'
  | 'initializing'
  | 'initialized'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'stopped'
  | 'error'

/**
 * Base plugin interface - all plugins must implement this
 */
export interface SkelmPlugin {
  /** Unique plugin identifier */
  readonly id: string

  /** Human-readable name */
  readonly name: string

  /** Plugin version */
  readonly version: string

  /** Current lifecycle state */
  readonly state: PluginLifecycle

  /** Plugin type */
  readonly type: PluginType

  /** Initialize the plugin with configuration */
  initialize(config: PluginConfig): Promise<void>

  /** Start the plugin (after initialization) */
  start(): Promise<void>

  /** Stop the plugin gracefully */
  stop(): Promise<void>

  /** Check if plugin is healthy */
  healthCheck(): Promise<PluginHealthStatus>

  /** Get plugin metadata */
  getMetadata(): PluginMetadata
}

/**
 * Plugin types
 */
export type PluginType = 'model' | 'agent' | 'workflow' | 'utility'

/**
 * Model plugin - implements an LLM provider
 */
export interface ModelPlugin extends SkelmPlugin {
  readonly type: 'model'

  /** Get the model provider instance */
  getModelProvider(): import('./model-provider.js').ModelProvider
}

/**
 * Agent plugin - implements a coding agent SDK
 */
export interface AgentPlugin extends SkelmPlugin {
  readonly type: 'agent'

  /** Get the agent provider instance */
  getAgentProvider(): import('./agent-provider.js').AgentProvider
}

/**
 * Workflow plugin - integrates with external services
 */
export interface WorkflowPlugin extends SkelmPlugin {
  readonly type: 'workflow'

  /** Get plugin-specific services/clients */
  getService<T extends string>(serviceName: T): unknown

  /** Register event handlers */
  on(event: string, handler: (...args: unknown[]) => void): void

  /** Unregister event handlers */
  off(event: string, handler: (...args: unknown[]) => void): void
}

/**
 * Plugin configuration
 */
export interface PluginConfig {
  /** Plugin-specific settings */
  [key: string]: unknown

  /** Optional secret references */
  secrets?: Record<string, { secret: string }>
}

/**
 * Plugin metadata
 */
export interface PluginMetadata {
  id: string
  name: string
  version: string
  type: PluginType
  description?: string
  author?: string
  license?: string
  homepage?: string
  dependencies?: Record<string, string>
  capabilities?: string[]
  requiredPermissions?: string[]
}

/**
 * Plugin health status
 */
export interface PluginHealthStatus {
  healthy: boolean
  status: string
  details?: Record<string, unknown>
  lastCheck: string
  errors?: string[]
}

/**
 * Provider model information
 */
export interface ProviderModel {
  id: string
  name: string
  provider: string
  capabilities?: string[]
  contextWindow?: number
  maxTokens?: number
  pricing?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

/**
 * Plugin loader and registry
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, SkelmPlugin>()
  private readonly models = new Map<string, ModelPlugin>()
  private readonly agents = new Map<string, AgentPlugin>()
  private readonly workflows = new Map<string, WorkflowPlugin>()
  private initialized = false

  /**
   * Register a plugin
   */
  async register(plugin: SkelmPlugin, config?: PluginConfig): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`)
    }

    this.plugins.set(plugin.id, plugin)

    if (plugin.type === 'model') {
      this.models.set(plugin.id, plugin as ModelPlugin)
    } else if (plugin.type === 'agent') {
      this.agents.set(plugin.id, plugin as AgentPlugin)
    } else if (plugin.type === 'workflow') {
      this.workflows.set(plugin.id, plugin as WorkflowPlugin)
    }

    // Auto-initialize if registry is already initialized
    if (this.initialized && config) {
      await plugin.initialize(config)
      await plugin.start()
    }
  }

  /**
   * Unregister a plugin
   */
  async unregister(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    await plugin.stop()
    this.plugins.delete(pluginId)

    if (plugin.type === 'model') {
      this.models.delete(pluginId)
    } else if (plugin.type === 'agent') {
      this.agents.delete(pluginId)
    } else if (plugin.type === 'workflow') {
      this.workflows.delete(pluginId)
    }
  }

  /**
   * Get a plugin by ID
   */
  get(pluginId: string): SkelmPlugin | undefined {
    return this.plugins.get(pluginId)
  }

  /**
   * Get a model plugin
   */
  getModel(modelId: string): ModelPlugin | undefined {
    return this.models.get(modelId)
  }

  /**
   * Get an agent plugin
   */
  getAgent(agentId: string): AgentPlugin | undefined {
    return this.agents.get(agentId)
  }

  /**
   * Get a workflow plugin
   */
  getWorkflow(workflowId: string): WorkflowPlugin | undefined {
    return this.workflows.get(workflowId)
  }

  /**
   * List all registered plugins
   */
  list(): readonly SkelmPlugin[] {
    return [...this.plugins.values()]
  }

  /**
   * List all model plugins
   */
  listModels(): readonly ModelPlugin[] {
    return [...this.models.values()]
  }

  /**
   * List all agent plugins
   */
  listAgents(): readonly AgentPlugin[] {
    return [...this.agents.values()]
  }

  /**
   * List all workflow plugins
   */
  listWorkflows(): readonly WorkflowPlugin[] {
    return [...this.workflows.values()]
  }

  /**
   * Initialize all plugins with their configs
   */
  async initializeAll(configs: Record<string, PluginConfig>): Promise<void> {
    for (const plugin of this.plugins.values()) {
      const pluginConfig = configs[plugin.id]
      if (pluginConfig) {
        await plugin.initialize(pluginConfig)
      }
    }
    this.initialized = true
  }

  /**
   * Start all initialized plugins
   */
  async startAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.state === 'initialized') {
        await plugin.start()
      }
    }
  }

  /**
   * Stop all plugins
   */
  async stopAll(): Promise<void> {
    const errors: string[] = []
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.stop()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        errors.push(`Failed to stop ${plugin.id}: ${msg}`)
      }
    }
    if (errors.length > 0) {
      console.error('Plugin stop errors:', errors)
    }
  }

  /**
   * Health check all plugins
   */
  async healthCheckAll(): Promise<Record<string, PluginHealthStatus>> {
    const results: Record<string, PluginHealthStatus> = {}
    for (const plugin of this.plugins.values()) {
      try {
        results[plugin.id] = await plugin.healthCheck()
      } catch (error) {
        results[plugin.id] = {
          healthy: false,
          status: 'error',
          errors: [error instanceof Error ? error.message : String(error)],
          lastCheck: new Date().toISOString(),
        }
      }
    }
    return results
  }

  /**
   * Dispose the registry
   */
  async dispose(): Promise<void> {
    await this.stopAll()
    this.plugins.clear()
    this.models.clear()
    this.agents.clear()
    this.workflows.clear()
    this.initialized = false
  }
}

/**
 * Plugin loader for dynamic plugin discovery
 */
export class PluginLoader {
  /**
   * Load a plugin from a package name.
   * Handles three export shapes:
   *   1. A SkelmPlugin (id + type + initialize + start + stop)
   *   2. An Integration (id + capabilities + init + shutdown + healthCheck) —
   *      wrapped as a WorkflowPlugin via @skelm/integration-sdk
   *   3. A factory function `createPlugin()` or named export `plugin`
   */
  async loadFromPackage(packageName: string): Promise<SkelmPlugin> {
    try {
      const module = await import(packageName)

      // Shape 1 & 2: default export
      if (module.default && typeof module.default === 'object') {
        const exported = module.default as unknown
        if (this.isSkelmPlugin(exported)) return exported
        if (this.isIntegration(exported)) return await this.wrapIntegration(exported)
      }

      // Shape 3: createPlugin factory
      if (typeof module.createPlugin === 'function') {
        const plugin = await module.createPlugin()
        if (this.isSkelmPlugin(plugin)) return plugin
        if (this.isIntegration(plugin)) return await this.wrapIntegration(plugin)
      }

      // Shape 3b: named `plugin` export
      if (typeof module.plugin === 'object' && module.plugin !== null) {
        const plugin = module.plugin as unknown
        if (this.isSkelmPlugin(plugin)) return plugin
        if (this.isIntegration(plugin)) return await this.wrapIntegration(plugin)
      }

      throw new Error(`Package ${packageName} does not export a valid SkelmPlugin or Integration`)
    } catch (error) {
      throw new Error(
        `Failed to load plugin from ${packageName}: ${error instanceof Error ? error.message : error}`,
      )
    }
  }

  /**
   * Load multiple plugins from package names
   */
  async loadFromPackages(packageNames: readonly string[]): Promise<SkelmPlugin[]> {
    const plugins: SkelmPlugin[] = []
    const errors: string[] = []

    for (const packageName of packageNames) {
      try {
        const plugin = await this.loadFromPackage(packageName)
        plugins.push(plugin)
      } catch (error) {
        errors.push(`${packageName}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (errors.length > 0) {
      console.warn('Plugin load errors:', errors)
    }

    return plugins
  }

  /**
   * Type guard for SkelmPlugin
   */
  private isSkelmPlugin(value: unknown): value is SkelmPlugin {
    return (
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      'type' in value &&
      'initialize' in value &&
      'start' in value &&
      'stop' in value
    )
  }

  /**
   * Type guard for the Integration interface from @skelm/integration-sdk.
   * Detects the shape without a hard import — avoids a potential circular dep.
   */
  private isIntegration(value: unknown): value is {
    id: string
    name: string
    capabilities: Record<string, boolean>
    config: unknown
    init(): Promise<void>
    shutdown(): Promise<void>
    healthCheck(): Promise<boolean>
  } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      'capabilities' in value &&
      'init' in value &&
      typeof (value as Record<string, unknown>).init === 'function' &&
      'shutdown' in value &&
      'healthCheck' in value &&
      // Distinguish from SkelmPlugin (which has 'type' and 'initialize')
      !('type' in value && 'initialize' in value)
    )
  }

  /**
   * Dynamically import @skelm/integration-sdk and wrap an Integration as a
   * WorkflowPlugin. The dynamic import keeps @skelm/core free of a hard dep
   * on @skelm/integration-sdk.
   *
   * @skelm/core does NOT declare @skelm/integration-sdk in its package.json
   * (not even as an optionalDependency) because integration-sdk peer-depends
   * on @skelm/core, which would form a workspace cycle. End users that load
   * Integration plugins install @skelm/integration-sdk directly, or pull it
   * in transitively via the `skelm` meta-package or @skelm/integrations.
   */
  private async wrapIntegration(integration: unknown): Promise<SkelmPlugin> {
    let sdk: { createIntegrationPlugin: (i: unknown) => unknown }
    try {
      sdk = (await import('@skelm/integration-sdk' as string)) as {
        createIntegrationPlugin: (i: unknown) => unknown
      }
    } catch {
      throw new Error(
        '@skelm/integration-sdk is required to load Integration plugins — add it as a dependency',
      )
    }
    return sdk.createIntegrationPlugin(integration) as SkelmPlugin
  }
}

/**
 * Create a plugin from a skelm config
 */
export async function createPluginsFromConfig(config: SkelmConfig): Promise<SkelmPlugin[]> {
  const plugins: SkelmPlugin[] = []
  const loader = new PluginLoader()

  // Load provider plugins from backends config
  if (config.backends) {
    for (const [backendId, backendConfig] of Object.entries(config.backends)) {
      if (backendId === 'default' || backendId === 'infer' || backendId === 'agent') continue
      if (typeof backendConfig === 'string') continue

      // Check if this backend has a plugin field
      const pluginEntry = (backendConfig as Record<string, unknown>).plugin as string | undefined
      if (pluginEntry) {
        try {
          const plugin = await loader.loadFromPackage(pluginEntry)
          plugins.push(plugin)
        } catch (error) {
          console.warn(`Failed to load plugin for backend ${backendId}:`, error)
        }
      }
    }
  }

  // Load workflow plugins from plugins array
  if (config.plugins) {
    const workflowPlugins = await loader.loadFromPackages(config.plugins)
    plugins.push(...workflowPlugins)
  }

  return plugins
}
