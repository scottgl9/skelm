/**
 * Opencode provider plugin
 * 
 * Implements ProviderPluginBase for the opencode.ai coding agent.
 */

import { ProviderPluginBase } from '@skelm/core'
import type { ProviderCapabilities, ProviderSpecificCapabilities, ProviderModel, PluginConfig } from '@skelm/core'
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
  private config: OpencodeProviderConfig = {}

  constructor(options?: { logLevel?: 'debug' | 'info' | 'warn' | 'error' }) {
    super({
      id: 'opencode',
      name: 'Opencode.ai',
      version: '1.0.0',
      description: 'Opencode.ai coding agent provider',
      logLevel: options?.logLevel,
    })
  }

  /**
   * Provider capabilities
   */
  get capabilities(): ProviderCapabilities {
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
  async initialize(config: OpencodeProviderConfig): Promise<void> {
    this.config = {
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      agent: config.agent,
      timeout: config.timeout,
      maxRetries: config.maxRetries,
      logLevel: config.logLevel,
    }
    await super.initialize(config)
  }

  /**
   * Provider-specific initialization
   */
  protected async doInitialize(config: OpencodeProviderConfig): Promise<void> {
    // Validate API key
    const apiKey = config.apiKey ?? process.env.OPENCODE_API_KEY
    if (!apiKey) {
      throw new Error('Opencode API key is required. Set apiKey config or OPENCODE_API_KEY env var.')
    }
  }

  /**
   * Create a backend instance
   */
  async createBackend(options?: OpencodeBackendOptions): Promise<ReturnType<typeof createOpencodeBackend>> {
    if (!this.initialized) {
      throw new Error('Provider must be initialized before creating backends')
    }

    const config: OpencodeBackendOptions = {
      apiKey: this.config.apiKey ?? process.env.OPENCODE_API_KEY!,
      ...(this.config.apiUrl !== undefined && { apiUrl: this.config.apiUrl }),
      ...(this.config.agent !== undefined && { agent: this.config.agent }),
      ...(options?.timeout !== undefined && { timeout: options.timeout }),
      ...(options?.maxRetries !== undefined && { maxRetries: options.maxRetries }),
      ...(options?.logLevel !== undefined && { logLevel: options.logLevel }),
    }

    return createOpencodeBackend(config)
  }

  /**
   * List available models
   */
  async listModels(): Promise<ProviderModel[]> {
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
  protected async doHealthCheck(): Promise<Partial<PluginHealthStatus>> {
    // Basic connectivity check
    const apiKey = this.config.apiKey ?? process.env.OPENCODE_API_KEY
    if (!apiKey) {
      return { healthy: false, status: 'no-api-key' }
    }

    // Try a simple API call
    try {
      const response = await fetch(`${this.config.apiUrl ?? 'https://api.opencode.ai'}/health`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 5000,
      })

      if (response.ok) {
        return { healthy: true, status: 'healthy' }
      }

      return { healthy: false, status: `api-error-${response.status}` }
    } catch (error) {
      return { healthy: false, status: 'api-unreachable' }
    }
  }

  /**
   * Validate configuration
   */
  protected validateConfig(config: OpencodeProviderConfig): OpencodeProviderConfig {
    const apiKey = config.apiKey ?? process.env.OPENCODE_API_KEY
    if (!apiKey) {
      throw new Error('Opencode API key is required')
    }
    return config
  }
}

/**
 * Create an Opencode provider instance
 */
export function createOpencodeProvider(options?: { logLevel?: 'debug' | 'info' | 'warn' | 'error' }): OpencodeProvider {
  return new OpencodeProvider(options)
}
