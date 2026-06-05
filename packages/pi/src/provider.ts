/**
 * Pi provider plugin
 */

import { ProviderPluginBase } from '@skelm/core'
import type {
  PluginConfig,
  PluginHealthStatus,
  ProviderCapabilities,
  ProviderModel,
} from '@skelm/core'
import type { SkelmBackend } from '@skelm/core'
import { createPiSdkBackend } from './sdk-backend.js'
import type { PiSdkBackendOptions } from './types.js'

export interface PiProviderConfig extends PluginConfig {
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  cwd?: string
  timeout?: number
  maxConcurrent?: number
}

export class PiProvider extends ProviderPluginBase {
  private _providerName: string | undefined
  private _model: string | undefined
  private _baseUrl: string | undefined
  private _apiKey: string | undefined
  private _cwd: string | undefined
  private _timeout: number | undefined
  private _maxConcurrent: number | undefined

  constructor(options?: { logLevel?: 'debug' | 'info' | 'warn' | 'error' }) {
    super({
      id: 'pi',
      name: 'Pi Coding Agent',
      version: '1.0.0',
      description: 'Pi coding agent provider (@earendil-works/pi-coding-agent)',
      logLevel: options?.logLevel ?? 'info',
    })
  }

  override get capabilities(): ProviderCapabilities {
    return {
      prompt: false,
      streaming: true,
      sessionLifecycle: true,
      mcp: false,
      skills: true,
      modelSelection: false,
      toolPermissions: 'native',
      providerSpecific: {
        structuredOutput: false,
        vision: true,
        reasoning: true,
        toolCalling: true,
        functionCalling: false,
        systemPrompts: true,
        multiTurn: true,
        streaming: true,
        contextCaching: false,
        parallelToolCalls: false,
      },
      maxContextWindow: 128000,
      maxOutputTokens: 16384,
      pricing: {},
    }
  }

  protected override async doInitialize(config: PiProviderConfig): Promise<void> {
    this._providerName = config.provider
    this._model = config.model
    this._baseUrl = config.baseUrl
    this._apiKey = config.apiKey
    this._cwd = config.cwd
    this._timeout = config.timeout
    this._maxConcurrent = config.maxConcurrent
  }

  protected override async doStart(): Promise<void> {}

  override async healthCheck(): Promise<PluginHealthStatus> {
    try {
      await import('@earendil-works/pi-coding-agent')
      return {
        healthy: true,
        status: 'pi SDK available',
        lastCheck: new Date().toISOString(),
      }
    } catch (err) {
      return {
        healthy: false,
        status: `pi SDK not available: ${(err as Error).message}`,
        lastCheck: new Date().toISOString(),
        errors: [(err as Error).message],
      }
    }
  }

  override async listModels(): Promise<ProviderModel[]> {
    if (this._model) {
      return [{ id: this._model, name: this._model, provider: this._providerName ?? 'pi' }]
    }
    return []
  }

  override async createBackend(options?: Record<string, unknown>): Promise<SkelmBackend> {
    const opts = options as Partial<PiSdkBackendOptions> | undefined
    return createPiSdkBackend({
      ...(this._providerName !== undefined && { provider: this._providerName }),
      ...(this._model !== undefined && { model: this._model }),
      ...(this._baseUrl !== undefined && { baseUrl: this._baseUrl }),
      ...(this._apiKey !== undefined && { apiKey: this._apiKey }),
      ...(this._cwd !== undefined && { cwd: this._cwd }),
      ...(this._timeout !== undefined && { timeout: this._timeout }),
      ...(this._maxConcurrent !== undefined && { maxConcurrent: this._maxConcurrent }),
      ...opts,
    })
  }
}

export function createPiProvider(options?: {
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}): PiProvider {
  return new PiProvider(options)
}
