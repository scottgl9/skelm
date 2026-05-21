/**
 * Opencode provider plugin
 *
 * Implements ProviderPluginBase for the opencode.ai coding agent.
 */

import { BackendConfigError, ProviderPluginBase } from '@skelm/core'
import type {
  PluginConfig,
  PluginHealthStatus,
  ProviderCapabilities,
  ProviderModel,
  ProviderSpecificCapabilities,
} from '@skelm/core'
import { createOpencodeBackend } from './backend.js'
import type { OpencodeBackendOptions } from './types.js'

/**
 * Opencode provider configuration
 */
export interface OpencodeProviderConfig extends PluginConfig {
  /** Opencode API key */
  apiKey?: string
  /** Opencode API URL */
  apiUrl?: string
  /** Default agent */
  agent?: string
  /** Request timeout */
  timeout?: number
  /** Max retries */
  maxRetries?: number
  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Opencode provider implementation
 */
export class OpencodeProvider extends ProviderPluginBase {
  protected override config: {
    apiKey?: string
    apiUrl?: string
    agent?: string
    timeout?: number
    maxRetries?: number
    logLevel?: 'debug' | 'info' | 'warn' | 'error'
  } = {}

  constructor(options?: { logLevel?: 'debug' | 'info' | 'warn' | 'error' }) {
    super({
      id: 'opencode',
      name: 'Opencode.ai',
      version: '1.0.0',
      description: 'Opencode.ai coding agent provider',
      logLevel: options?.logLevel ?? 'info',
    })
  }

  /**
   * Provider capabilities
   */
  override get capabilities(): ProviderCapabilities {
    return {
      prompt: true,
      streaming: true,
      sessionLifecycle: true,
      mcp: true,
      skills: false,
      modelSelection: true,
      toolPermissions: 'wrapped',
      providerSpecific: {
        structuredOutput: true,
        vision: false,
        reasoning: true,
        toolCalling: true,
        functionCalling: true,
        systemPrompts: true,
        multiTurn: true,
        streaming: true,
        contextCaching: false,
        parallelToolCalls: true,
      },
      maxContextWindow: 128000,
      maxOutputTokens: 4096,
      pricing: {
        inputPer1K: 0, // Free tier
        outputPer1K: 0,
      },
    }
  }

  /**
   * Initialize the provider
   */
  override async initialize(config: OpencodeProviderConfig): Promise<void> {
    this.config = {}

    if (config.apiKey !== undefined) {
      this.config.apiKey = config.apiKey
    }
    if (config.apiUrl !== undefined) {
      this.config.apiUrl = config.apiUrl
    }
    if (config.agent !== undefined) {
      this.config.agent = config.agent
    }
    if (config.timeout !== undefined) {
      this.config.timeout = config.timeout
    }
    if (config.maxRetries !== undefined) {
      this.config.maxRetries = config.maxRetries
    }
    if (config.logLevel !== undefined) {
      this.config.logLevel = config.logLevel
    }

    await super.initialize(config)
  }

  /**
   * Provider-specific initialization
   */
  protected override async doInitialize(config: OpencodeProviderConfig): Promise<void> {
    // Validate API key
    const apiKey = config.apiKey ?? process.env.OPENCODE_API_KEY
    if (!apiKey) {
      throw new BackendConfigError(
        'Opencode API key is required. Set apiKey config or OPENCODE_API_KEY env var.',
        'opencode',
      )
    }
  }

  /**
   * Create a backend instance
   */
  async createBackend(
    options?: OpencodeBackendOptions,
  ): Promise<ReturnType<typeof createOpencodeBackend>> {
    if (!this.initialized) {
      throw new BackendConfigError(
        'Provider must be initialized before creating backends',
        'opencode',
      )
    }

    const config: OpencodeBackendOptions = {}
    const apiKey = this.config.apiKey ?? process.env.OPENCODE_API_KEY
    if (apiKey !== undefined) config.apiKey = apiKey

    if (this.config.apiUrl !== undefined) {
      config.apiUrl = this.config.apiUrl
    }
    if (this.config.agent !== undefined) {
      config.agent = this.config.agent
    }
    if (options?.timeout !== undefined) {
      config.timeout = options.timeout
    }
    if (options?.maxRetries !== undefined) {
      config.maxRetries = options.maxRetries
    }
    if (options?.logLevel !== undefined) {
      config.logLevel = options.logLevel
    }

    return createOpencodeBackend(config)
  }

  /**
   * List available models
   */
  override async listModels(): Promise<ProviderModel[]> {
    // Opencode supports multiple models including Qwen variants
    return [
      {
        id: 'build',
        name: 'Build Agent',
        provider: 'opencode',
        capabilities: ['file-ops', 'bash', 'mcp'],
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: 'review',
        name: 'Review Agent',
        provider: 'opencode',
        capabilities: ['file-ops', 'code-review'],
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: 'debug',
        name: 'Debug Agent',
        provider: 'opencode',
        capabilities: ['file-ops', 'bash', 'debugging'],
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: 'qwen35',
        name: 'Qwen 3.5',
        provider: 'opencode',
        capabilities: ['file-ops', 'bash', 'reasoning', 'vision'],
        contextWindow: 131072,
        maxTokens: 16384,
        pricing: { input: 0, output: 0 },
      },
      {
        id: 'qwen36',
        name: 'Qwen 3.6',
        provider: 'opencode',
        capabilities: ['file-ops', 'bash', 'reasoning', 'vision'],
        contextWindow: 262144,
        maxTokens: 16384,
        pricing: { input: 0, output: 0 },
      },
    ]
  }

  /**
   * Health check
   */
  protected override async doHealthCheck(): Promise<{
    healthy: boolean
    status: string
    details?: Record<string, unknown>
  }> {
    // Basic connectivity check
    const apiKey = this.config.apiKey ?? process.env.OPENCODE_API_KEY
    if (!apiKey) {
      return { healthy: false, status: 'no-api-key' }
    }

    // Try a simple API call
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(`${this.config.apiUrl ?? 'https://api.opencode.ai'}/health`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        return { healthy: true, status: 'healthy' }
      }

      return { healthy: false, status: `api-error-${response.status}` }
    } catch {
      return { healthy: false, status: 'api-unreachable' }
    }
  }

  /**
   * Validate configuration
   */
  protected override validateConfig(config: OpencodeProviderConfig): OpencodeProviderConfig {
    const apiKey = config.apiKey ?? process.env.OPENCODE_API_KEY
    if (!apiKey) {
      throw new BackendConfigError('Opencode API key is required', 'opencode')
    }
    return config
  }
}

/**
 * Create an Opencode provider instance
 */
export function createOpencodeProvider(options?: {
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}): OpencodeProvider {
  return new OpencodeProvider(options)
}
