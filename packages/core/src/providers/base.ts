/**
 * ProviderPluginBase - Abstract base class for all coding agent providers
 *
 * Common functionality for provider plugins:
 * - Lifecycle management
 * - Health checks
 * - Error handling and retry logic
 * - Logging
 * - Config validation
 */

import type { SkelmBackend, BackendCapabilities } from '../backend.js'
import type {
  ProviderModel,
  PluginHealthStatus,
  PluginLifecycle,
  PluginConfig,
} from '../plugins.js'

/**
 * Provider-specific capabilities beyond the base backend capabilities
 */
export interface ProviderSpecificCapabilities {
  /** Supports structured output (JSON schema) */
  structuredOutput: boolean
  /** Supports vision/image input */
  vision: boolean
  /** Supports reasoning/thinking tokens */
  reasoning: boolean
  /** Supports tool calling */
  toolCalling: boolean
  /** Supports function calling */
  functionCalling: boolean
  /** Supports system prompts */
  systemPrompts: boolean
  /** Supports multi-turn conversations */
  multiTurn: boolean
  /** Supports streaming responses */
  streaming: boolean
  /** Supports context caching */
  contextCaching: boolean
  /** Supports parallel tool calls */
  parallelToolCalls: boolean
}

/**
 * Combined capabilities for a provider
 */
export interface ProviderCapabilities extends BackendCapabilities {
  /** Provider-specific capabilities */
  providerSpecific: ProviderSpecificCapabilities
  /** Max context window size */
  maxContextWindow?: number
  /** Max output tokens */
  maxOutputTokens?: number
  /** Pricing information */
  pricing?: {
    inputPer1K?: number
    outputPer1K?: number
    cacheReadPer1K?: number
    cacheWritePer1K?: number
  }
}

/**
 * Abstract base class for provider plugins
 */
export abstract class ProviderPluginBase {
  readonly type = 'provider' as const
  state: PluginLifecycle = 'loading'

  protected config: PluginConfig = {}
  protected initialized = false
  protected logger: ProviderLogger

  /**
   * Create a provider plugin
   */
  constructor(
    protected options: {
      id: string
      name: string
      version: string
      description?: string
      logLevel?: 'debug' | 'info' | 'warn' | 'error'
    },
  ) {
    this.logger = new ProviderLogger(options.id, options.logLevel ?? 'info')
  }

  /**
   * Plugin identifier
   */
  get id(): string {
    return this.options.id
  }

  /**
   * Human-readable name
   */
  get name(): string {
    return this.options.name
  }

  /**
   * Plugin version
   */
  get version(): string {
    return this.options.version
  }

  /**
   * Plugin description
   */
  get description(): string | undefined {
    return this.options.description
  }

  /**
   * Initialize the provider with configuration
   */
  async initialize(config: PluginConfig): Promise<void> {
    this.logger.info('Initializing provider', { id: this.id })

    try {
      this.state = 'initializing'
      this.config = this.validateConfig(config)
      await this.doInitialize(config)
      this.initialized = true
      this.state = 'initialized'
      this.logger.info('Provider initialized successfully')
    } catch (error) {
      this.state = 'error'
      this.logger.error('Failed to initialize provider', error)
      throw this.wrapError(error, 'initialization')
    }
  }

  /**
   * Subclass hook for provider-specific initialization
   */
  protected abstract doInitialize(config: PluginConfig): Promise<void>

  /**
   * Create a backend instance
   */
  abstract createBackend(config?: Record<string, unknown>): Promise<SkelmBackend>

  /**
   * List available models (optional)
   */
  listModels?(config?: Record<string, unknown>): Promise<ProviderModel[]>

  /**
   * Get provider capabilities
   */
  abstract get capabilities(): ProviderCapabilities

  /**
   * Start the provider
   */
  async start(): Promise<void> {
    if (!this.initialized) {
      throw new ProviderError(`Provider ${this.id} must be initialized before starting`)
    }

    if (this.state === 'active') {
      this.logger.warn('Provider already started')
      return
    }

    this.logger.info('Starting provider', { id: this.id })
    this.state = 'starting'

    try {
      await this.doStart()
      this.state = 'active'
      this.logger.info('Provider started successfully')
    } catch (error) {
      this.state = 'error'
      this.logger.error('Failed to start provider', error)
      throw this.wrapError(error, 'startup')
    }
  }

  /**
   * Subclass hook for provider-specific startup
   */
  protected async doStart(): Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Stop the provider gracefully
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return
    }

    this.logger.info('Stopping provider', { id: this.id })
    this.state = 'stopping'

    try {
      await this.doStop()
      this.state = 'stopped'
      this.logger.info('Provider stopped successfully')
    } catch (error) {
      this.logger.error('Error while stopping provider', error)
      this.state = 'error'
      throw this.wrapError(error, 'shutdown')
    }
  }

  /**
   * Subclass hook for provider-specific shutdown
   */
  protected async doStop(): Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<PluginHealthStatus> {
    const status: PluginHealthStatus = {
      healthy: false,
      status: 'unknown',
      lastCheck: new Date().toISOString(),
    }

    try {
      if (!this.initialized) {
        status.status = 'not-initialized'
        return status
      }

      if (this.state === 'error') {
        status.status = 'error'
        return status
      }

      const health = await this.doHealthCheck()
      status.healthy = health.healthy ?? false
      status.status = health.status ?? 'unknown'
      if (health.details !== undefined) {
        status.details = health.details
      }
    } catch (error) {
      status.status = 'error'
      status.errors = [error instanceof Error ? error.message : String(error)]
      return status
    }

    return status
  }

  /**
   * Subclass hook for health check
   */
  protected async doHealthCheck(): Promise<{
    healthy: boolean
    status: string
    details?: Record<string, unknown>
  }> {
    return { healthy: true, status: 'healthy' }
  }

  /**
   * Get plugin metadata
   */
  getMetadata(): PluginMetadata {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      type: this.type,
      description: this.description ?? '',
    }
  }

  /**
   * Validate configuration
   */
  protected validateConfig(config: PluginConfig): PluginConfig {
    // Default implementation returns config as-is
    // Subclasses should override to validate their specific config
    return config
  }

  /**
   * Wrap errors with provider context
   */
  protected wrapError(error: unknown, context: string): ProviderError {
    const message = error instanceof Error ? error.message : String(error)
    return new ProviderError(`Provider ${this.id} ${context} failed: ${message}`, error)
  }

  /**
   * Retry with exponential backoff
   */
  protected async withRetry<T>(
    fn: () => Promise<T>,
    options: {
      maxRetries?: number
      initialDelayMs?: number
      maxDelayMs?: number
      backoffFactor?: number
      retryable?: (error: unknown) => boolean
    } = {},
  ): Promise<T> {
    const {
      maxRetries = 3,
      initialDelayMs = 1000,
      maxDelayMs = 30000,
      backoffFactor = 2,
      retryable = () => true,
    } = options

    let lastError: unknown
    let delay = initialDelayMs

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error

        if (!retryable(error) || attempt === maxRetries) {
          throw error
        }

        this.logger.warn(`Retry attempt ${attempt + 1}/${maxRetries}`, {
          error: error instanceof Error ? error.message : String(error),
        })

        await this.sleep(delay)
        delay = Math.min(delay * backoffFactor, maxDelayMs)
      }
    }

    throw lastError
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Provider-specific error type
 */
export class ProviderError extends Error {
  override readonly name: string = 'ProviderError'
  public override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause
  }
}

export class ProviderAuthenticationError extends ProviderError {
  override readonly name: string = 'ProviderAuthenticationError'
}

export class ProviderRateLimitError extends ProviderError {
  override readonly name: string = 'ProviderRateLimitError'
  public readonly retryAfter: number | undefined

  constructor(message: string, cause?: unknown, retryAfter?: number) {
    super(message, cause)
    this.retryAfter = retryAfter
  }
}

export class ProviderTimeoutError extends ProviderError {
  override readonly name: string = 'ProviderTimeoutError'
}

export class ProviderNotFoundError extends ProviderError {
  override readonly name: string = 'ProviderNotFoundError'
}

/**
 * Simple logger for providers
 */
class ProviderLogger {
  constructor(
    private providerId: string,
    private level: 'debug' | 'info' | 'warn' | 'error' = 'info',
  ) {}

  debug(message: string, data?: unknown): void {
    if (this.shouldLog('debug')) {
      console.debug(`[Provider:${this.providerId}] ${message}`, data ?? '')
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog('info')) {
      console.info(`[Provider:${this.providerId}] ${message}`, data ?? '')
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog('warn')) {
      console.warn(`[Provider:${this.providerId}] ${message}`, data ?? '')
    }
  }

  error(message: string, error?: unknown): void {
    if (this.shouldLog('error')) {
      console.error(`[Provider:${this.providerId}] ${message}`, error ?? '')
    }
  }

  private shouldLog(level: 'debug' | 'info' | 'warn' | 'error'): boolean {
    const levels: Record<string, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    }
    const levelValue = levels[level]
    const currentLevelValue = levels[this.level]
    return (
      levelValue !== undefined && currentLevelValue !== undefined && levelValue >= currentLevelValue
    )
  }
}

/**
 * Plugin metadata type (imported from plugins.ts)
 */
export interface PluginMetadata {
  id: string
  name: string
  version: string
  type: 'provider' | 'workflow' | 'utility'
  description?: string
  author?: string
  license?: string
  homepage?: string
  dependencies?: Record<string, string>
  capabilities?: string[]
  requiredPermissions?: string[]
}
