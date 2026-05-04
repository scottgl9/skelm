// Pi RPC client — communicates with `pi --mode rpc` via the documented
// JSONL protocol over stdin/stdout.
//
// Protocol reference: pi/docs/rpc.md
// Key events: message_update(text_delta) for streaming, agent_end for completion

import { type ChildProcess, spawn } from 'node:child_process' // @subprocess-ok: spawns pi coding agent in RPC mode
import { StringDecoder } from 'node:string_decoder'

export interface PiRpcClientOptions {
  /** Path to the pi binary (default: 'pi') */
  command?: string
  /** Provider to use (e.g. 'llamacpp') */
  provider?: string
  /** Model ID (e.g. 'qwen36') */
  model?: string
  /** Working directory for the agent */
  cwd?: string
  /** Extra CLI arguments */
  args?: readonly string[]
  /** Whether to persist the session (default: false — ephemeral) */
  persistSession?: boolean
}

export interface PiRpcResponse {
  text: string
  stopReason: string
  usage?: { inputTokens: number; outputTokens: number }
}

export class PiRpcClient {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (e: Error) => void }
  >()
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private eventListeners: Array<(event: Record<string, unknown>) => void> = []
  private readonly options: PiRpcClientOptions

  constructor(options: PiRpcClientOptions = {}) {
    this.options = options
  }

  /** Spawn `pi --mode rpc` and wait until it emits its first output (ready state). */
  async start(): Promise<void> {
    const command = this.options.command ?? 'pi'
    const args: string[] = ['--mode', 'rpc']
    if (this.options.provider) args.push('--provider', this.options.provider)
    if (this.options.model) args.push('--model', this.options.model)
    if (!this.options.persistSession) args.push('--no-session')
    if (this.options.args) args.push(...this.options.args)

    const proc = spawn(command, args, {
      cwd: this.options.cwd ?? process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = proc

    proc.stderr?.on('data', () => {
      /* discard — pi logs diagnostics to stderr */
    })
    proc.on('error', (err) => this._rejectAll(err))
    proc.on('exit', (code, sig) => {
      const msg = code !== null ? `pi exited with code ${code}` : `pi killed by ${sig}`
      this._rejectAll(new Error(msg))
    })

    // Attach line reader — using StringDecoder + manual split on \n (per pi docs,
    // readline is not safe because it splits on Unicode line separators too)
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk)
      let idx = this.buffer.indexOf('\n')
      while (idx !== -1) {
        let line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.trim()) this._handleLine(line)
        idx = this.buffer.indexOf('\n')
      }
    })

    // Wait briefly for process to become ready (first line from stdout or timeout)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => resolve(), 500) // pi starts fast
      proc.once('error', (e) => {
        clearTimeout(t)
        reject(e)
      })
      proc.once('exit', () => {
        clearTimeout(t)
        reject(new Error('pi exited before ready'))
      })
      // Resolve as soon as we get any line
      const orig = this._handleLine.bind(this)
      this._handleLine = (line: string) => {
        clearTimeout(t)
        resolve()
        this._handleLine = orig
        orig(line)
      }
    })
  }

  /** Send a prompt, collect streamed text, return when agent_end fires. */
  async prompt(message: string, timeoutMs = 120_000): Promise<PiRpcResponse> {
    if (!this.proc) throw new Error('PiRpcClient not started')

    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    const id = String(this.nextId++)

    // Register event listener for streaming
    let resolveIdle!: () => void
    let rejectIdle!: (e: Error) => void
    const idlePromise = new Promise<void>((res, rej) => {
      resolveIdle = res
      rejectIdle = rej
    })

    const listener = (ev: Record<string, unknown>) => {
      if (ev.type === 'message_update') {
        const aev = ev.assistantMessageEvent as Record<string, unknown> | undefined
        if (aev?.type === 'text_delta' && typeof aev.delta === 'string') {
          text += aev.delta
        }
      }
      if (ev.type === 'agent_end') {
        // Extract token usage from last assistant message
        const msgs = ev.messages as Array<Record<string, unknown>> | undefined
        if (msgs) {
          for (const m of msgs) {
            if (m.role === 'assistant' && m.usage) {
              const u = m.usage as Record<string, number>
              inputTokens = u.input ?? 0
              outputTokens = u.output ?? 0
            }
          }
        }
        this.eventListeners = this.eventListeners.filter((l) => l !== listener)
        resolveIdle()
      }
    }
    this.eventListeners.push(listener)

    // Send the prompt command
    this._send({ id, type: 'prompt', message })

    // Wait for response confirmation (that the prompt was accepted)
    await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })

    // Wait for agent_end with timeout
    const timeoutHandle = setTimeout(() => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener)
      rejectIdle(new Error(`pi prompt timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    try {
      await idlePromise
    } finally {
      clearTimeout(timeoutHandle)
    }

    return {
      text: text.trim(),
      stopReason: 'end_turn',
      usage: { inputTokens, outputTokens },
    }
  }

  /** Cancel the current agent operation. */
  async abort(): Promise<void> {
    if (!this.proc) return
    this._send({ type: 'abort' })
  }

  /** Shut down the pi process. */
  async stop(): Promise<void> {
    this.proc?.kill('SIGTERM')
    this.proc = null
    this.pending.clear()
    this.eventListeners = []
  }

  private _handleLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    // Dispatch response to pending request handler
    if (msg.type === 'response' && msg.id !== undefined) {
      const id = String(msg.id)
      const handler = this.pending.get(id)
      if (handler) {
        this.pending.delete(id)
        if (msg.success === false) {
          handler.reject(new Error(String(msg.error ?? 'pi command failed')))
        } else {
          handler.resolve(msg.data ?? msg)
        }
        return
      }
    }

    // Broadcast to event listeners
    for (const l of this.eventListeners) l(msg)
  }

  private _send(cmd: Record<string, unknown>): void {
    if (!this.proc?.stdin) throw new Error('pi process not running')
    this.proc.stdin.write(`${JSON.stringify(cmd)}\n`)
  }

  private _rejectAll(err: Error): void {
    for (const h of this.pending.values()) h.reject(err)
    this.pending.clear()
    for (const l of this.eventListeners) {
      // Notify event listeners of the failure so promptAndWait resolves/rejects
      l({ type: 'agent_end', messages: [], error: err.message })
    }
    this.eventListeners = []
  }
}
