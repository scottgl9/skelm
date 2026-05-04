/**
 * Agent Provider abstraction for coding agent SDKs
 *
 * Supports: ACP (Agent Communication Protocol), pi, opencode, GitHub Copilot, etc.
 * Used for agent() steps in workflows
 */

import type { SkelmBackend } from './backend.js'
import type { Context, AgentStep } from './types.js'
import type { RunMetadata } from './types.js'

/**
 * Agent provider configuration
 */
export interface AgentProviderConfig {
  /** Provider identifier (e.g., 'acp', 'opencode', 'pi', 'github-copilot') */
  provider: string

  /** API endpoint or connection string */
  endpoint?: string

  /** API key or token */
  apiKey?: string

  /** Agent-specific configuration */
  agentConfig?: Record<string, unknown>

  /** Timeout for agent operations (ms) */
  timeoutMs?: number

  /** Retry configuration */
  retry?: {
    maxAttempts?: number
    delayMs?: number
  }

  /** Provider-specific options */
  [key: string]: unknown
}

/**
 * Agent request/response types
 */
export interface AgentRequest {
  /** Unique request ID */
  requestId: string

  /** Prompt or task for the agent */
  prompt: string

  /** Conversation history */
  history?: AgentMessage[]

  /** Working directory */
  cwd?: string

  /** Allowed tools/capabilities */
  allowedTools?: string[]

  /** Timeout (ms) */
  timeoutMs?: number

  /** Streaming preference */
  stream?: boolean
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCallId?: string
  toolName?: string
}

export interface AgentResponse {
  /** Response ID */
  responseId: string

  /** Agent's response */
  content: string

  /** Tool calls to execute */
  toolCalls?: AgentToolCall[]

  /** Finished reason */
  finishReason?: string

  /** Raw response */
  raw?: unknown
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface AgentToolResult {
  toolCallId: string
  result: string
  isError: boolean
}

/**
 * Agent provider interface
 */
export interface AgentProvider {
  /** Provider identifier */
  readonly id: string

  /** Provider name */
  readonly name: string

  /** Initialize with configuration */
  initialize(config: AgentProviderConfig): Promise<void>

  /** Create a backend instance */
  createBackend(config?: Partial<AgentProviderConfig>): Promise<SkelmBackend>

  /** Execute a single agent request */
  execute(request: AgentRequest): Promise<AgentResponse>

  /** Execute with streaming */
  executeStream?(request: AgentRequest): AsyncIterable<AgentResponse>

  /** Check health */
  healthCheck(): Promise<{ healthy: boolean; status: string }>

  /** Get current configuration */
  getConfig(): AgentProviderConfig

  /** List available agents */
  listAgents?(): Promise<string[]>
}

/**
 * Base class for agent providers
 */
export abstract class AgentProviderBase implements AgentProvider {
  abstract readonly id: string
  abstract readonly name: string

  protected config: AgentProviderConfig | null = null
  protected initialized = false

  async initialize(config: AgentProviderConfig): Promise<void> {
    this.config = config
    this.initialized = true
    await this.doInitialize(config)
  }

  abstract doInitialize(config: AgentProviderConfig): Promise<void>

  async createBackend(config?: Partial<AgentProviderConfig>): Promise<SkelmBackend> {
    if (!this.initialized) {
      throw new Error(`Agent provider not initialized: ${this.id}`)
    }
    return this.doCreateBackend(config)
  }

  abstract doCreateBackend(config?: Partial<AgentProviderConfig>): Promise<SkelmBackend>

  async execute(request: AgentRequest): Promise<AgentResponse> {
    if (!this.initialized) {
      throw new Error(`Agent provider not initialized: ${this.id}`)
    }
    return this.doExecute(request)
  }

  abstract doExecute(request: AgentRequest): Promise<AgentResponse>

  async healthCheck(): Promise<{ healthy: boolean; status: string }> {
    return { healthy: this.initialized, status: this.initialized ? 'ready' : 'not-initialized' }
  }

  getConfig(): AgentProviderConfig {
    if (!this.config) {
      throw new Error(`Agent provider not initialized: ${this.id}`)
    }
    return this.config
  }
}

/**
 * Agent registry for managing multiple providers
 */
export class AgentRegistry {
  private readonly providers = new Map<string, AgentProvider>()
  private defaultProvider: string | undefined

  /**
   * Register an agent provider
   */
  register(provider: AgentProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Agent provider already registered: ${provider.id}`)
    }
    this.providers.set(provider.id, provider)
  }

  /**
   * Get an agent provider by ID
   */
  get(providerId: string): AgentProvider | undefined {
    return this.providers.get(providerId)
  }

  /**
   * Set default provider
   */
  setDefault(providerId: string): void {
    this.defaultProvider = providerId
  }

  /**
   * Get default provider
   */
  getDefault(): AgentProvider | undefined {
    if (this.defaultProvider) {
      return this.providers.get(this.defaultProvider)
    }
    return this.providers.values().next().value
  }

  /**
   * List all registered providers
   */
  list(): readonly AgentProvider[] {
    return [...this.providers.values()]
  }

  /**
   * Initialize all providers
   */
  async initializeAll(configs: Record<string, AgentProviderConfig>): Promise<void> {
    for (const provider of this.providers.values()) {
      const config = configs[provider.id]
      if (config) {
        await provider.initialize(config)
      }
    }
  }

  /**
   * Health check all providers
   */
  async healthCheckAll(): Promise<Record<string, { healthy: boolean; status: string }>> {
    const results: Record<string, { healthy: boolean; status: string }> = {}
    for (const provider of this.providers.values()) {
      try {
        results[provider.id] = await provider.healthCheck()
      } catch (error) {
        results[provider.id] = {
          healthy: false,
          status: `error: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    return results
  }

  /**
   * Dispose all providers
   */
  async dispose(): Promise<void> {
    this.providers.clear()
    this.defaultProvider = undefined
  }
}

/**
 * Execute an agent step using the agent registry
 */
export async function executeAgentStep(
  step: AgentStep,
  ctx: Context,
  registry: AgentRegistry,
): Promise<AgentResponse> {
  const providerId = step.backend || (registry.getDefault()?.id as string | undefined)
  if (!providerId) {
    throw new Error('No agent provider specified or available')
  }

  const provider = registry.get(providerId)
  if (!provider) {
    throw new Error(`Agent provider not found: ${providerId}`)
  }

  // Resolve prompt
  const resolvedPrompt = typeof step.prompt === 'function' ? step.prompt(ctx) : step.prompt

  const request: AgentRequest = {
    requestId: `agent-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    prompt: resolvedPrompt,
  }

  if (step.maxTurns) {
    request.timeoutMs = step.maxTurns * 60000
  }

  return provider.execute(request)
}

/**
 * Resolve template variables in prompt (deprecated - use step functions directly)
 */
function resolveTemplate(template: string, ctx: Context): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = ctx.steps?.[key]
    return value !== undefined ? String(value) : `{{${key}}}`
  })
}
