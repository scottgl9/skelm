// ACP client — high-level interface over JsonRpcStdioTransport.
//
// Spawns the agent process, performs the initialize handshake, opens a
// session, sends prompts, and aggregates streaming session/update
// notifications into a final result.

import { type ChildProcess, spawn } from 'node:child_process'
import {
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type McpServerSpec,
  PROTOCOL_VERSION,
  type SessionNewRequest,
  type SessionNewResponse,
  type SessionPromptResponse,
  type SessionUpdate,
  type StopReason,
} from './protocol.js'
import { JsonRpcStdioTransport } from './transport.js'

export interface AcpSpawnOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface AcpPromptResult {
  /** Concatenated agent message text, in the order chunks arrived. */
  text: string
  /** Stop reason returned by session/prompt. */
  stopReason: StopReason
  /** Every `session/update` notification observed during the prompt. */
  updates: ReadonlyArray<SessionUpdate>
}

export class AcpProtocolError extends Error {
  override readonly name = 'AcpProtocolError'
}

export class AcpClient {
  private nextId = 1
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private updateListeners: Array<(update: SessionUpdate) => void> = []
  private process: ChildProcess | null = null
  private transport: JsonRpcStdioTransport | null = null
  private sessionId: string | null = null

  /** Spawn the agent process and run the ACP initialize handshake. */
  async start(opts: AcpSpawnOptions): Promise<InitializeResponse> {
    const proc = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = proc
    proc.stderr?.on('data', () => {
      // ACP agents may write diagnostic logs to stderr; we ignore them
      // unless the caller wires up its own listener.
    })
    proc.on('error', (err) => this.rejectAll(err))
    proc.on('exit', (code, signal) => {
      const reason = code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`
      this.rejectAll(new AcpProtocolError(`agent process exited (${reason})`))
    })
    if (!proc.stdin || !proc.stdout) {
      throw new AcpProtocolError('agent process did not expose stdio')
    }
    this.transport = new JsonRpcStdioTransport(proc.stdout, proc.stdin)
    this.transport.on('response', (msg: JsonRpcResponse) => this.onResponse(msg))
    this.transport.on('notification', (msg: JsonRpcNotification) => this.onNotification(msg))
    this.transport.on('error', (err: Error) => this.rejectAll(err))

    const initParams: InitializeRequest = { protocolVersion: PROTOCOL_VERSION }
    return await this.request<InitializeResponse>('initialize', initParams)
  }

  /** Open a new ACP session against the configured cwd. */
  async newSession(opts: {
    cwd: string
    mcpServers?: ReadonlyArray<McpServerSpec>
  }): Promise<string> {
    const params: SessionNewRequest = {
      cwd: opts.cwd,
      mcpServers: opts.mcpServers ?? [],
    }
    const res = await this.request<SessionNewResponse>('session/new', params)
    this.sessionId = res.sessionId
    return res.sessionId
  }

  /**
   * Send a single prompt; return when the agent emits a `stopReason`.
   * Streaming session/update notifications are accumulated and returned
   * for the caller to inspect.
   */
  async prompt(opts: {
    text: string
    extraBlocks?: ReadonlyArray<ContentBlock>
    onUpdate?: (u: SessionUpdate) => void
  }): Promise<AcpPromptResult> {
    if (this.sessionId === null) {
      throw new AcpProtocolError('session not started; call newSession() first')
    }
    const sessionId = this.sessionId
    const updates: SessionUpdate[] = []
    let text = ''

    const listener = (update: SessionUpdate): void => {
      updates.push(update)
      if (update.sessionUpdate === 'agent_message_chunk') {
        const c = (update as { content: ContentBlock }).content
        if (c.type === 'text') text += c.text
      }
      opts.onUpdate?.(update)
    }
    this.updateListeners.push(listener)
    try {
      const blocks: ContentBlock[] = [{ type: 'text', text: opts.text }]
      if (opts.extraBlocks) blocks.push(...opts.extraBlocks)
      const res = await this.request<SessionPromptResponse>('session/prompt', {
        sessionId,
        prompt: blocks,
      })
      return { text, stopReason: res.stopReason, updates }
    } finally {
      this.updateListeners = this.updateListeners.filter((l) => l !== listener)
    }
  }

  /** Cancel the in-flight prompt, if any. */
  async cancel(): Promise<void> {
    if (this.sessionId === null) return
    this.notify('session/cancel', { sessionId: this.sessionId })
  }

  /** Cleanly shut down the agent process. */
  async stop(): Promise<void> {
    if (this.process === null) return
    try {
      await new Promise<void>((resolve) => {
        const proc = this.process
        if (!proc) return resolve()
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
        // Give the agent a beat to drain.
        const grace = setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL')
          resolve()
        }, 2000)
        grace.unref()
      })
    } finally {
      this.process = null
      this.transport = null
      this.sessionId = null
    }
  }

  // ── private ─────────────────────────────────────────────────────────────

  private async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.transport) throw new AcpProtocolError('transport not initialized')
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.transport.send({ jsonrpc: '2.0', id, method, params })
    return (await promise) as T
  }

  private notify(method: string, params?: unknown): void {
    if (!this.transport) return
    this.transport.send({ jsonrpc: '2.0', method, params })
  }

  private onResponse(msg: JsonRpcResponse): void {
    const handler = this.pending.get(msg.id)
    if (!handler) return
    this.pending.delete(msg.id)
    if (msg.error) {
      handler.reject(new AcpProtocolError(`${msg.error.code}: ${msg.error.message}`))
    } else {
      handler.resolve(msg.result)
    }
  }

  private onNotification(msg: JsonRpcNotification): void {
    if (msg.method === 'session/update' && msg.params) {
      const params = msg.params as { update: SessionUpdate }
      for (const l of this.updateListeners) l(params.update)
    }
    // Other notification methods (e.g. fs/read_text_file requests from
    // the agent) are out of scope for the v0.1 client; agents that send
    // them with a request id will time out per the JSON-RPC contract.
  }

  private rejectAll(err: Error): void {
    for (const handler of this.pending.values()) handler.reject(err)
    this.pending.clear()
  }
}
