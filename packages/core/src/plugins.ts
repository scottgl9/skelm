/**
 * Plugin system for skelm
 * 
 * Supports two plugin types:
 * 1. Provider plugins - coding agent backends (opencode, pi, anthropic, etc.)
 * 2. Workflow plugins - integrations (slack, matrix, discord, etc.)
 */

import type { SkelmBackend } from './backend.js'
import type { SkelmConfig } from './config.js'

/**
 * Plugin lifecycle stages
 */
export type PluginLifecycle = 'loading' | 'loaded' | 'initializing' | 'initialized' | 'starting' | 'active' | 'stopping' | 'stopped' | 'error'

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
export type PluginType = 'provider' | 'workflow' | 'utility'

/**
 * Provider plugin - implements a coding agent backend
 */
export interface ProviderPlugin extends SkelmPlugin {
  readonly type: 'provider'
  
  /** Create a backend instance */
  createBackend(config?: Record<string, unknown>): Promise<SkelmBackend>
  
  /** List available models/providers */
  listModels?(config?: Record<string, unknown>): Promise<ProviderModel[]>
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
  private readonly providers = new Map<string, ProviderPlugin>()
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

    if (plugin.type === 'provider') {
      this.providers.set(plugin.id, plugin as ProviderPlugin)
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

    if (plugin.type === 'provider') {
      this.providers.delete(pluginId)
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
   * Get a provider plugin
   */
  getProvider(providerId: string): ProviderPlugin | undefined {
    return this.providers.get(providerId)
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
   * List all provider plugins
   */
  listProviders(): readonly ProviderPlugin[] {
    return [...this.providers.values()]
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
    this.providers.clear()
    this.workflows.clear()
    this.initialized = false
  }
}

/**
 * Plugin loader for dynamic plugin discovery
 */
export class PluginLoader {
  /**
   * Load a plugin from a package name
   */
  async loadFromPackage(packageName: string): Promise<SkelmPlugin> {
    try {
      const module = await import(packageName)
      
      // Look for default export that implements SkelmPlugin
      if (module.default && typeof module.default === 'object') {
        const plugin = module.default as unknown
        if (this.isSkelmPlugin(plugin)) {
          return plugin
        }
      }

      // Look for named export 'createPlugin' or 'plugin'
      if (typeof module.createPlugin === 'function') {
        const plugin = await module.createPlugin()
        if (this.isSkelmPlugin(plugin)) {
          return plugin
        }
      }

      if (typeof module.plugin === 'object' && module.plugin !== null) {
        const plugin = module.plugin as unknown
        if (this.isSkelmPlugin(plugin)) {
          return plugin
        }
      }

      throw new Error(`Package ${packageName} does not export a valid SkelmPlugin`)
    } catch (error) {
      throw new Error(`Failed to load plugin from ${packageName}: ${error instanceof Error ? error.message : error}`)
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
      if (backendId === 'default' || backendId === 'llm' || backendId === 'agent') continue
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
