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

export interface McpSpawnOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
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

  async start(opts: McpSpawnOptions): Promise<InitializeResponse> {
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
    this.notify('notifications/initialized')
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
    if (!this.transport) throw new McpProtocolError('transport not initialized')
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.transport.send({ jsonrpc: '2.0', id, method, params })
    return (await promise) as T
  }

  private notify(method: string, params?: unknown): void {
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
}
