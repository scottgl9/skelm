// Opencode HTTP client — spawns `opencode serve --port 0` once per backend
// instance and reuses the process across multiple prompt() calls (one session
// per call, server kept alive). Disposed via dispose() when the backend is done.
//
// Improvements over the original:
//   #1 — Cleaner spawn: OPENCODE_CONFIG_CONTENT + no dead cancel()/getSessionId()
//   #2 — Model/logLevel injected via OPENCODE_CONFIG_CONTENT at server startup
//   #3 — Non-blocking promptAsync + SSE stream instead of blocking session.prompt()

import { type ChildProcess, spawn } from 'node:child_process' // @subprocess-ok: spawns opencode serve for HTTP backend
import { createOpencodeClient } from '@opencode-ai/sdk'
import type { AgentRequest, AgentResponse } from '@skelm/core'
import type { OpencodeBackendOptions } from './types.js'

type SdkClient = ReturnType<typeof createOpencodeClient>

// Shape of OPENCODE_CONFIG_CONTENT — subset of opencode's Config type.
interface OpencodeServerConfig {
  model?: string
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
}

export class OpencodeClientWrapper {
  private proc: ChildProcess | null = null
  private client: SdkClient | null = null
  private startPromise: Promise<void> | null = null
  private readonly options: OpencodeBackendOptions

  constructor(options: OpencodeBackendOptions) {
    this.options = options
  }

  /** Ensure the opencode server is running. Safe to call concurrently. */
  async ensureStarted(): Promise<void> {
    if (this.client !== null) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this._start()
    await this.startPromise
  }

  /** Alias kept for callers that start the server explicitly before first use. */
  async start(): Promise<void> {
    return this.ensureStarted()
  }

  private async _start(): Promise<void> {
    const command = this.options.command ?? 'opencode'

    // (#2) Inject model and logLevel via OPENCODE_CONFIG_CONTENT so opencode
    // uses them as its defaults for every session, without needing per-session
    // body overrides.
    const serverConfig: OpencodeServerConfig = {}
    if (this.options.model) serverConfig.model = this.options.model
    if (this.options.logLevel && this.options.logLevel !== 'off') {
      const logLevelMap = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' } as const
      serverConfig.logLevel = logLevelMap[this.options.logLevel]
    }

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(command, ['serve', '--port', '0'], {
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(serverConfig) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.proc = proc

      let resolved = false
      let buf = ''

      const tryParse = (chunk: Buffer) => {
        if (resolved) return
        buf += chunk.toString()
        const m = buf.match(/listening on (https?:\/\/[^\s]+)/)
        if (m?.[1]) {
          resolved = true
          this.client = createOpencodeClient({ baseUrl: m[1].trim() })
          resolve()
        }
      }

      proc.stdout?.on('data', tryParse)
      proc.stderr?.on('data', tryParse)
      proc.once('error', (err) => {
        if (!resolved) reject(err)
        else this._handleExit()
      })
      proc.once('exit', () => {
        if (!resolved) reject(new Error('opencode serve exited before becoming ready'))
        else this._handleExit()
      })
      setTimeout(() => {
        if (!resolved) reject(new Error('opencode serve: timed out waiting for port'))
      }, 15_000)
    })
  }

  private _handleExit(): void {
    this.proc = null
    this.client = null
    this.startPromise = null
  }

  async prompt(
    request: AgentRequest,
    signal: AbortSignal,
    timeoutMs = 300_000,
  ): Promise<AgentResponse> {
    await this.ensureStarted()
    if (!this.client) throw new Error('opencode serve not ready')

    const cwd = request.cwd ?? process.cwd()

    const sessResult = await this.client.session.create({ query: { directory: cwd } })
    if (!sessResult.data) {
      throw new Error(`session.create failed: ${JSON.stringify(sessResult.error)}`)
    }
    const sessionId = sessResult.data.id

    // (#3) Subscribe to the global SSE stream BEFORE calling promptAsync so
    // we don't miss events that fire immediately after the session starts.
    const sseAbort = new AbortController()
    const timeoutId = setTimeout(
      () => sseAbort.abort(new Error(`opencode timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    const onSignalAbort = () => sseAbort.abort(new Error('opencode aborted'))
    signal.addEventListener('abort', onSignalAbort, { once: true })

    try {
      const { stream } = await this.client.event.subscribe({ signal: sseAbort.signal })

      // (#3) Fire promptAsync — returns immediately; response arrives over SSE.
      // Model is already set via OPENCODE_CONFIG_CONTENT (#2), so no per-request body needed.
      const promptResult = await this.client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: request.prompt }] },
      })
      if (!promptResult.data) {
        throw new Error(`session.promptAsync failed: ${JSON.stringify(promptResult.error)}`)
      }

      return await this._collectFromStream(stream, sessionId, signal)
    } finally {
      clearTimeout(timeoutId)
      signal.removeEventListener('abort', onSignalAbort)
      sseAbort.abort() // close SSE connection
      // Best-effort abort of the session if we're bailing out early
      if (signal.aborted) {
        this.client?.session.abort({ path: { id: sessionId } }).catch(() => {})
      }
    }
  }

  // (#3) Collect text from SSE events for one session until it goes idle.
  private async _collectFromStream(
    stream: AsyncIterable<unknown>,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<AgentResponse> {
    // Each TextPart is updated incrementally; track the latest full text per part id.
    const textParts = new Map<string, string>()

    for await (const raw of stream) {
      if (signal.aborted) break

      const event = raw as { type: string; properties: Record<string, unknown> }

      if (event.type === 'session.error') {
        const props = event.properties as { sessionID?: string; error?: unknown }
        if (!props.sessionID || props.sessionID === sessionId) {
          throw new Error(`opencode session error: ${JSON.stringify(props.error)}`)
        }
      }

      if (event.type === 'message.part.updated') {
        const props = event.properties as {
          part: { type: string; sessionID: string; id: string; text?: string; synthetic?: boolean }
        }
        const { part } = props
        if (part.sessionID === sessionId && part.type === 'text' && !part.synthetic && part.text) {
          textParts.set(part.id, part.text)
        }
      }

      if (event.type === 'session.idle') {
        const props = event.properties as { sessionID: string }
        if (props.sessionID === sessionId) break
      }
    }

    if (signal.aborted) throw new Error('opencode agent aborted')

    const text = [...textParts.values()].join('')
    return { text: text.trim(), stopReason: 'end_turn' }
  }

  async dispose(): Promise<void> {
    this.proc?.kill('SIGTERM')
    this.proc = null
    this.client = null
    this.startPromise = null
  }
}
