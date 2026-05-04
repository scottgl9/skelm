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
import { createPiBackend } from './backend.js'
import type { PiBackendOptions } from './types.js'

export interface PiProviderConfig extends PluginConfig {
  command?: string
  provider?: string
  model?: string
  cwd?: string
  timeout?: number
  maxConcurrent?: number
}

export class PiProvider extends ProviderPluginBase {
  private _cmd = 'pi'
  private _providerName: string | undefined
  private _model: string | undefined
  private _cwd: string | undefined
  private _timeout: number | undefined
  private _maxConcurrent: number | undefined

  constructor(options?: { logLevel?: 'debug' | 'info' | 'warn' | 'error' }) {
    super({
      id: 'pi',
      name: 'Pi Coding Agent',
      version: '1.0.0',
      description: 'Pi coding agent provider (@mariozechner/pi-coding-agent)',
      logLevel: options?.logLevel ?? 'info',
    })
  }

  override get capabilities(): ProviderCapabilities {
    return {
      prompt: false,
      streaming: true,
      sessionLifecycle: true,
      mcp: false,
      skills: false,
      modelSelection: this._model !== undefined,
      toolPermissions: 'native',
      providerSpecific: {
        structuredOutput: false,
        vision: false,
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
    this._cmd = config.command ?? 'pi'
    this._providerName = config.provider
    this._model = config.model
    this._cwd = config.cwd
    this._timeout = config.timeout
    this._maxConcurrent = config.maxConcurrent
  }

  protected override async doStart(): Promise<void> {
    try {
      const { execSync } = await import('node:child_process')
      execSync(`${this._cmd} --version`, { stdio: 'ignore' })
    } catch {
      throw new Error(
        `Pi binary not found: '${this._cmd}'. Install: npm install -g @mariozechner/pi-coding-agent`,
      )
    }
  }

  override async healthCheck(): Promise<PluginHealthStatus> {
    try {
      const { execSync } = await import('node:child_process')
      const version = execSync(`${this._cmd} --version`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      return {
        healthy: true,
        status: `pi ${version} available`,
        lastCheck: new Date().toISOString(),
      }
    } catch (err) {
      return {
        healthy: false,
        status: `pi not available: ${(err as Error).message}`,
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
    const opts = options as Partial<PiBackendOptions> | undefined
    return createPiBackend({
      command: this._cmd,
      ...(this._providerName !== undefined && { provider: this._providerName }),
      ...(this._model !== undefined && { model: this._model }),
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
