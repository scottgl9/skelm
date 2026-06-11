import { type ChildProcess, spawn } from 'node:child_process'
import {
  type InitializeRequest,
  type InitializeResponse,
  type JsonRpcNotification,
  type JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  type ToolCallResponse,
  type ToolsListResponse,
} from './protocol.js'
import { JsonRpcLineTransport } from './transport.js'

export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000

export interface McpSpawnOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
}

export interface McpHttpOptions {
  url: string
  headers?: Readonly<Record<string, string>>
  fetch?: typeof fetch
  requestTimeoutMs?: number
}

export class McpProtocolError extends Error {
  override readonly name = 'McpProtocolError'
}

export class McpClient {
  private nextId = 1
  private readonly pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private process: ChildProcess | null = null
  private transport: JsonRpcLineTransport | null = null
  private http: McpHttpOptions | null = null
  private requestTimeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS

  async start(opts: McpSpawnOptions): Promise<InitializeResponse> {
    this.requestTimeoutMs = normalizeRequestTimeoutMs(opts.requestTimeoutMs)
    const proc = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = proc
    proc.stderr?.on('data', () => {})
    proc.on('error', (err) => this.rejectAll(err))
    proc.on('exit', (code, signal) => {
      const reason = code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`
      this.rejectAll(new McpProtocolError(`MCP server exited (${reason})`))
    })
    if (!proc.stdin || !proc.stdout) {
      throw new McpProtocolError('MCP server did not expose stdio')
    }
    this.transport = new JsonRpcLineTransport(proc.stdout, proc.stdin)
    this.transport.on('response', (msg: JsonRpcResponse) => this.onResponse(msg))
    this.transport.on('notification', (_msg: JsonRpcNotification) => {})
    this.transport.on('error', (err: Error) => this.rejectAll(err))

    const init = await this.request<InitializeResponse>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'skelm',
        version: '0.1.0',
      },
    } satisfies InitializeRequest)
    await this.notify('notifications/initialized')
    return init
  }

  async connectHttp(opts: McpHttpOptions): Promise<InitializeResponse> {
    this.http = opts
    this.requestTimeoutMs = normalizeRequestTimeoutMs(opts.requestTimeoutMs)
    const init = await this.request<InitializeResponse>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'skelm',
        version: '0.1.0',
      },
    } satisfies InitializeRequest)
    await this.notify('notifications/initialized')
    return init
  }

  async listTools(cursor?: string): Promise<ToolsListResponse> {
    return await this.request<ToolsListResponse>('tools/list', {
      ...(cursor !== undefined && { cursor }),
    })
  }

  async callTool(name: string, args?: unknown): Promise<ToolCallResponse> {
    return await this.request<ToolCallResponse>('tools/call', {
      name,
      ...(args !== undefined && { arguments: args }),
    })
  }

  async stop(): Promise<void> {
    if (this.http !== null) {
      this.http = null
      this.transport = null
      return
    }
    if (this.process === null) return
    try {
      await new Promise<void>((resolve) => {
        const proc = this.process
        if (!proc) return resolve()
        proc.once('exit', () => resolve())
        proc.stdin?.end()
        const grace = setTimeout(() => {
          if (!proc.killed) proc.kill('SIGTERM')
          resolve()
        }, 2000)
        grace.unref()
      })
    } finally {
      this.process = null
      this.transport = null
    }
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.http) {
      return await this.requestHttp<T>(method, params)
    }
    if (!this.transport) throw new McpProtocolError('transport not initialized')
    const id = this.nextId++
    let timer: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<unknown>((resolve, reject) => {
      const clearTimer = () => {
        if (timer !== undefined) clearTimeout(timer)
      }
      timer = setTimeout(() => {
        this.pending.delete(id)
        reject(requestTimeoutError(method, this.requestTimeoutMs))
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (value) => {
          clearTimer()
          resolve(value)
        },
        reject: (error) => {
          clearTimer()
          reject(error)
        },
      })
    })
    try {
      this.transport.send({ jsonrpc: '2.0', id, method, params })
    } catch (err) {
      if (timer !== undefined) clearTimeout(timer)
      this.pending.delete(id)
      throw err
    }
    return (await promise) as T
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    if (this.http) {
      const http = this.http
      const response = await this.withRequestTimeout(method, async (signal) => {
        return await (http.fetch ?? fetch)(http.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...http.headers,
          },
          body: JSON.stringify({ jsonrpc: '2.0', method, params }),
          signal,
        })
      })
      if (!response.ok && response.status !== 204) {
        throw new McpProtocolError(
          `MCP HTTP notification failed (${response.status} ${response.statusText})`,
        )
      }
      return
    }
    if (!this.transport) throw new McpProtocolError('transport not initialized')
    this.transport.send({ jsonrpc: '2.0', method, params })
  }

  private onResponse(msg: JsonRpcResponse): void {
    const handler = this.pending.get(msg.id)
    if (!handler) return
    this.pending.delete(msg.id)
    if (msg.error) {
      handler.reject(new McpProtocolError(`${msg.error.code}: ${msg.error.message}`))
    } else {
      handler.resolve(msg.result)
    }
  }

  private rejectAll(err: Error): void {
    for (const handler of this.pending.values()) handler.reject(err)
    this.pending.clear()
  }

  private async requestHttp<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    const http = this.http
    if (!http) {
      throw new McpProtocolError('HTTP transport not initialized')
    }
    const response = await this.withRequestTimeout(method, async (signal) => {
      return await (http.fetch ?? fetch)(http.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...http.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
      })
    })
    if (!response.ok) {
      throw new McpProtocolError(
        `MCP HTTP request failed (${response.status} ${response.statusText})`,
      )
    }
    const body = (await response.json()) as JsonRpcResponse<T>
    if (body.error) {
      throw new McpProtocolError(`${body.error.code}: ${body.error.message}`)
    }
    return body.result as T
  }

  private async withRequestTimeout<T>(
    method: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    let timeoutError: McpProtocolError | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      return await Promise.race([
        operation(controller.signal).catch((err) => {
          if (timeoutError !== null) throw timeoutError
          throw err
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timeoutError = requestTimeoutError(method, this.requestTimeoutMs)
            controller.abort()
            reject(timeoutError)
          }, this.requestTimeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

function normalizeRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MCP_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(value) || value <= 0) {
    throw new McpProtocolError('MCP request timeout must be a positive finite number')
  }
  return value
}

function requestTimeoutError(method: string, timeoutMs: number): McpProtocolError {
  return new McpProtocolError(`MCP request "${method}" timed out after ${timeoutMs}ms`)
}
