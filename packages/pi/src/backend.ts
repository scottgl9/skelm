/**
 * Pi coding agent backend for skelm
 * 
 * Uses subprocess/RPC mode to communicate with the Pi coding agent.
 * Permission enforcement at the skelm layer maintains control over execution.
 */

import type { SkelmBackend, BackendCapabilities, BackendContext, AgentRequest, AgentResponse, InferRequest, InferResponse } from '@skelm/core'
import type { PiBackendOptions } from './types.js'
import { validatePermissions, buildPermissionAuditEntry } from './permission-mapper.js'

/**
 * Custom error types for Pi backend
 */
export class PiBackendError extends Error {
  override readonly name = 'PiBackendError'
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
  }
}

export class PiBackendAuthenticationError extends PiBackendError {
  readonly name = 'PiBackendAuthenticationError'
}

export class PiBackendRateLimitError extends PiBackendError {
  readonly name = 'PiBackendRateLimitError'
}

export class PiBackendTimeoutError extends PiBackendError {
  readonly name = 'PiBackendTimeoutError'
}

/**
 * Pi backend capabilities - wrapped mode with permission enforcement
 */
const capabilities: BackendCapabilities = {
  prompt: true,
  streaming: true,
  sessionLifecycle: true,
  mcp: true,
  skills: false, // Pi handles skills internally
  modelSelection: true,
  toolPermissions: 'wrapped', // We enforce permissions at skelm layer
}

/**
 * Create a Pi coding agent backend using subprocess/RPC mode
 */
export function createPiBackend(options: PiBackendOptions = {}): SkelmBackend {
  const config = {
    command: options.command ?? 'pi',
    cwd: options.cwd,
    args: options.args ?? [],
    timeout: options.timeout ?? 300000, // 5 min default
    maxRetries: options.maxRetries ?? 3,
    logLevel: options.logLevel ?? 'info',
  }

  return {
    id: 'pi',
    label: 'Pi Coding Agent',
    capabilities,

    async infer(request: InferRequest, context: BackendContext): Promise<InferResponse> {
      // Pi is primarily an agent runtime, not a single-shot inference backend
      // For now, we delegate to run() with maxTurns=1
      const agentResponse = await runPiSubprocess(
        config,
        {
          prompt: request.messages.map(m => m.content).join('\n'),
          ...(request.system !== undefined && { system: request.system }),
          maxTurns: 1,
          permissions: context.permissions,
        },
        context
      )
      return {
        ...(agentResponse.text !== undefined && { text: agentResponse.text }),
        ...(agentResponse.structured !== undefined && { structured: agentResponse.structured }),
        ...(agentResponse.usage !== undefined && { usage: agentResponse.usage }),
      }
    },

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      const { signal, permissions } = context

      // Validate permissions before proceeding
      if (permissions) {
        const result = validatePermissions(permissions, request.prompt)
        
        if (result.denied.length > 0) {
          console.warn('Permission denied for Pi agent request:', result.denied)
          const auditEntry = buildPermissionAuditEntry(
            'unknown',
            'unknown',
            permissions,
            { allowed: result.allowed, denied: result.denied }
          )
          console.warn('Permission audit:', auditEntry)
          throw new Error(`Permission denied: ${result.denied.join(', ')}`)
        }
      }

      // Check for abort signal
      if (signal.aborted) {
        throw new Error('Request cancelled')
      }

      try {
        return await runPiSubprocess(config, request, context)
      } catch (error) {
        if (error instanceof PiBackendError) {
          throw error
        }
        if (error instanceof Error) {
          if (error.message.includes('EACCES') || error.message.includes('ENOENT')) {
            throw new PiBackendAuthenticationError(`Pi agent not found or not executable. Ensure 'pi' is installed: npm install -g @mariozechner/pi-coding-agent`, error)
          }
          throw new PiBackendError('Pi agent execution failed', error)
        }
        throw new PiBackendError('Unknown error while running Pi agent')
      }
    },

    async dispose() {
      // Cleanup if needed
    },
  }
}

/**
 * Run Pi agent as a subprocess using RPC mode
 */
async function runPiSubprocess(
  config: { command: string; cwd?: string; args: readonly string[]; timeout: number; maxRetries: number; logLevel: 'debug' | 'info' | 'warn' | 'error' },
  request: AgentRequest,
  context: BackendContext
): Promise<AgentResponse> {
  const { spawn } = await import('child_process')
  const { promisify } = await import('util')
  const setTimeoutPromise = promisify(setTimeout)

  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    
    const piProcess = spawn(config.command, [
      '--mode', 'rpc',
      ...config.args,
    ], {
      ...(config.cwd !== undefined && { cwd: config.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      piProcess.kill('SIGTERM')
      reject(new PiBackendTimeoutError(`Pi agent timed out after ${config.timeout}ms`))
    }, config.timeout)

    piProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
      // Log streaming output
      if (config.logLevel === 'debug') {
        console.debug('[Pi stdout]', data.toString())
      }
    })

    piProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
      console.error('[Pi stderr]', data.toString())
    })

    piProcess.on('error', (error: Error) => {
      clearTimeout(timeoutHandle)
      reject(new PiBackendError('Failed to spawn Pi process', error))
    })

    piProcess.on('close', (code: number | null) => {
      clearTimeout(timeoutHandle)
      
      if (timedOut) return
      
      if (code === 0) {
        // Parse RPC response
        const text = parsePiRpcResponse(stdout)
        resolve({
          ...(text !== undefined && { text }),
          stopReason: code === 0 ? 'completed' : 'error',
          usage: {
            inputTokens: 0, // Pi doesn't expose token counts in RPC mode yet
            outputTokens: 0,
          },
        })
      } else {
        reject(new PiBackendError(`Pi process exited with code ${code}: ${stderr}`))
      }
    })

    // Send the prompt to Pi
    try {
      // Pi RPC mode expects JSONL input
      const rpcRequest = {
        jsonrpc: '2.0',
        method: 'session.prompt',
        params: {
          prompt: request.prompt,
          ...(request.system !== undefined && { system: request.system }),
          ...(request.maxTurns !== undefined && { maxTurns: request.maxTurns }),
        },
        id: 1,
      }
      piProcess.stdin?.write(JSON.stringify(rpcRequest) + '\n')
      piProcess.stdin?.end()
    } catch (error) {
      piProcess.kill()
      reject(new PiBackendError('Failed to send request to Pi', error))
    }
  })
}

/**
 * Parse Pi RPC response from stdout
 */
function parsePiRpcResponse(output: string): string | undefined {
  if (!output || output.trim() === '') {
    return undefined
  }
  const lines = output.split('\n').filter(line => line.trim())
  for (const line of lines) {
    try {
      const json = JSON.parse(line)
      if (json.result?.text) {
        return json.result.text
      }
      if (json.result) {
        return JSON.stringify(json.result)
      }
    } catch {
      // Not JSON, might be raw output
      if (!line.startsWith('{')) {
        return line
      }
    }
  }
  return undefined
}
