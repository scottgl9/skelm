/**
 * Pi provider plugin
 * 
 * Implements ProviderPluginBase for the Pi coding agent.
 * Uses subprocess/RPC mode for communication.
 */

import { ProviderPluginBase } from '@skelm/core'
import type { ProviderCapabilities, ProviderSpecificCapabilities, ProviderModel, PluginConfig, PluginHealthStatus } from '@skelm/core'
import { createPiBackend } from './backend.js'
import type { PiBackendOptions } from './types.js'

/**
 * Pi provider configuration
 */
export interface PiProviderConfig extends PluginConfig {
  /** Pi command (defaults to 'pi') */
  command?: string
  /** Working directory */
  cwd?: string
  /** Additional arguments */
  args?: readonly string[]
  /** Request timeout */
  timeout?: number
  /** Max retries */
  maxRetries?: number
  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Pi provider implementation
 */
export class PiProvider extends ProviderPluginBase {
  private config: PiProviderConfig & {
    command: string
    cwd: string | undefined
    args: readonly string[]
    timeout: number
    maxRetries: number
    logLevel: 'debug' | 'info' | 'warn' | 'error'
  } = {
    command: 'pi',
    cwd: undefined,
    args: [],
    timeout: 300000,
    maxRetries: 3,
    logLevel: 'info',
  }

  constructor(options?: { logLevel?: 'debug' | 'info' | 'warn' | 'error' }) {
    super({
      id: 'pi',
      name: 'Pi Coding Agent',
      version: '1.0.0',
      description: 'Pi coding agent provider (https://pi.dev)',
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
      skills: false, // Pi handles skills internally
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
        parallelToolCalls: false,
      },
      maxContextWindow: 200000,
      maxOutputTokens: 4096,
      pricing: {
        inputPer1K: undefined, // Depends on configured model
        outputPer1K: undefined,
      },
    }
  }

  /**
   * Initialize the provider
   */
  async initialize(config: PiProviderConfig): Promise<void> {
    this.config = {
      command: config.command ?? 'pi',
      cwd: config.cwd ?? undefined,
      args: config.args ?? [],
      timeout: config.timeout ?? 300000,
      maxRetries: config.maxRetries ?? 3,
      logLevel: config.logLevel ?? 'info',
    }
    await super.initialize(config)
  }

  /**
   * Provider-specific initialization
   */
  protected async doInitialize(config: PiProviderConfig): Promise<void> {
    // Check if pi command is available
    try {
      const { execSync } = await import('child_process')
      execSync('pi --version', { stdio: 'ignore' })
      this.logger.info('Pi agent found')
    } catch {
      this.logger.warn('Pi agent not found in PATH. Ensure it is installed: npm install -g @mariozechner/pi-coding-agent')
    }
  }

  /**
   * Create a backend instance
   */
  async createBackend(options?: PiBackendOptions): Promise<ReturnType<typeof createPiBackend>> {
    if (!this.initialized) {
      throw new Error('Provider must be initialized before creating backends')
    }

    const config: PiBackendOptions = {
      command: options?.command ?? this.config.command,
      cwd: options?.cwd ?? this.config.cwd,
      args: options?.args ?? this.config.args,
      timeout: options?.timeout ?? this.config.timeout,
      maxRetries: options?.maxRetries ?? this.config.maxRetries,
      logLevel: options?.logLevel ?? this.config.logLevel,
    }

    return createPiBackend(config)
  }

  /**
   * List available models
   */
  async listModels(): Promise<ProviderModel[]> {
    // Pi supports multiple providers, return common options
    return [
      {
        id: 'claude-3.5-sonnet',
        name: 'Claude 3.5 Sonnet',
        provider: 'pi',
        capabilities: ['file-ops', 'bash', 'reasoning'],
        contextWindow: 200000,
        maxTokens: 8192,
        pricing: { input: 3, output: 15 },
      },
      {
        id: 'claude-3-opus',
        name: 'Claude 3 Opus',
        provider: 'pi',
        capabilities: ['file-ops', 'bash', 'reasoning'],
        contextWindow: 200000,
        maxTokens: 4096,
        pricing: { input: 15, output: 75 },
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        provider: 'pi',
        capabilities: ['file-ops', 'bash'],
        contextWindow: 128000,
        maxTokens: 4096,
        pricing: { input: 5, output: 15 },
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        provider: 'pi',
        capabilities: ['file-ops', 'bash'],
        contextWindow: 128000,
        maxTokens: 4096,
        pricing: { input: 10, output: 30 },
      },
    ]
  }

  /**
   * Health check
   */
  protected async doHealthCheck(): Promise<Partial<PluginHealthStatus>> {
    // Check if pi command is available
    try {
      const { execSync } = await import('child_process')
      const version = execSync('pi --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return {
        healthy: true,
        status: 'healthy',
        details: { version: version.trim() },
      }
    } catch {
      return {
        healthy: false,
        status: 'pi-not-found',
        errors: ['Pi agent not found. Install with: npm install -g @mariozechner/pi-coding-agent'],
      }
    }
  }

  /**
   * Validate configuration
   */
  protected validateConfig(config: PiProviderConfig): PiProviderConfig {
    // Pi doesn't require API keys (uses subscriptions or local models)
    return config
  }
}

/**
 * Create a Pi provider instance
 */
export function createPiProvider(options?: { logLevel?: 'debug' | 'info' | 'warn' | 'error' }): PiProvider {
  return new PiProvider(options)
}
