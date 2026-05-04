/**
 * Script trigger implementation
 *
 * Runs external scripts (bash, Python, etc.) and emits events based on output
 * Allows users to implement custom triggers without modifying the framework
 */

import { spawn } from 'child_process'
import { TriggerError, TriggerPluginBase } from './base.js'
import type { TriggerConfig, TriggerEvent, TriggerHealthStatus, TriggerType } from './types.js'

/**
 * Script trigger configuration
 */
export interface ScriptTriggerConfig extends TriggerConfig {
  /** Command to execute (e.g., 'bash', 'python3', 'node') */
  command: string
  /** Arguments to pass to the command */
  args: string[]
  /** Working directory for the script */
  cwd?: string
  /** Environment variables for the script */
  env?: Record<string, string>
  /** Script path (for convenience, passed as last arg) */
  scriptPath?: string
  /** Polling interval in milliseconds (for periodic checks) */
  intervalMs?: number
  /** Timeout for script execution in milliseconds */
  timeoutMs?: number
  /** Optional workflow ID to invoke */
  workflowId?: string
  /** Optional input data to pass to the workflow */
  input?: unknown
}

/**
 * Script execution result
 */
interface ScriptResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

/**
 * Script trigger plugin
 */
export class ScriptTrigger extends TriggerPluginBase {
  private intervalId: NodeJS.Timeout | null = null
  private isRunning = false

  constructor(id: string, name: string, description?: string) {
    super(id, name, '1.0.0', description)
  }

  override getTriggerType(): TriggerType {
    return 'custom'
  }

  override async doInitialize(config: ScriptTriggerConfig): Promise<void> {
    if (!config.command) {
      throw new TriggerError('Script trigger requires a command')
    }
    if (!config.args || !Array.isArray(config.args)) {
      throw new TriggerError('Script trigger requires args array')
    }

    this.logger.info(`Initialized script trigger: ${config.command} ${config.args.join(' ')}`)
  }

  override async doStart(): Promise<void> {
    const config = this.config as ScriptTriggerConfig | null
    if (!config) {
      throw new TriggerError('Script trigger not initialized')
    }

    this.isRunning = true

    if (config.intervalMs) {
      // Periodic polling mode
      await this.runScript()
      this.intervalId = setInterval(() => {
        this.runScript().catch((error) => {
          this.logger.error(
            `Script execution error: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }, config.intervalMs)

      this.logger.info(`Script trigger started with ${config.intervalMs}ms interval`)
    } else {
      // One-shot mode
      await this.runScript()
      this.logger.info('Script trigger executed (one-shot)')
    }
  }

  override async doStop(): Promise<void> {
    this.isRunning = false

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    this.logger.info('Script trigger stopped')
  }

  override async doHealthCheck(): Promise<TriggerHealthStatus> {
    const config = this.config as ScriptTriggerConfig | null
    return {
      healthy: this.isRunning,
      status: this.isRunning ? 'running' : 'stopped',
      details: {
        command: config?.command,
        intervalMs: config?.intervalMs,
      },
    }
  }

  /**
   * Execute the script
   */
  private async runScript(): Promise<void> {
    const config = this.config as ScriptTriggerConfig | null
    if (!config) {
      throw new TriggerError('Script trigger not initialized')
    }

    this.logger.debug(`Executing script: ${config.command} ${config.args.join(' ')}`)

    const result = await this.executeScript(config.command, config.args, config)

    if (result.success) {
      // Parse output as JSON if possible
      let payload: unknown = result.stdout

      try {
        payload = JSON.parse(result.stdout)
      } catch {
        // Keep as string if not valid JSON
      }

      // Emit event
      const event: TriggerEvent = {
        eventId: `script-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        triggerId: this.id,
        triggerType: 'custom',
        timestamp: new Date(),
        payload,
        metadata: {
          source: 'script',
          command: config.command,
          args: config.args,
          exitCode: result.exitCode,
          ...(config.workflowId && { workflowId: config.workflowId }),
        },
      }

      await this.emitEvent(event)
      this.logger.debug(`Script executed successfully, exit code: ${result.exitCode}`)
    } else {
      this.logger.warn(`Script failed with exit code ${result.exitCode}: ${result.stderr}`)
    }
  }

  /**
   * Execute the script with timeout
   */
  private executeScript(
    command: string,
    args: string[],
    config: ScriptTriggerConfig,
  ): Promise<ScriptResult> {
    return new Promise((resolve) => {
      const timeoutMs = config.timeoutMs ?? 30000
      const env = { ...process.env, ...config.env }
      const cwd = config.cwd

      // Add script path as last arg if provided
      const scriptArgs = config.scriptPath ? [...args, config.scriptPath] : args

      const proc = spawn(command, scriptArgs, {
        env,
        cwd,
        shell: false,
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      const timeoutId = setTimeout(() => {
        timedOut = true
        proc.kill('SIGTERM')
        resolve({
          success: false,
          stdout,
          stderr: stderr || 'Script timed out',
          exitCode: -1,
          timedOut: true,
        })
      }, timeoutMs)

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code: number | null) => {
        clearTimeout(timeoutId)
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code ?? -1,
          timedOut,
        })
      })

      proc.on('error', (error: Error) => {
        clearTimeout(timeoutId)
        resolve({
          success: false,
          stdout,
          stderr: error.message,
          exitCode: -1,
          timedOut: false,
        })
      })
    })
  }
}

/**
 * Create a script trigger
 */
export function createScriptTrigger(id: string, name: string, description?: string): ScriptTrigger {
  return new ScriptTrigger(id, name, description)
}
