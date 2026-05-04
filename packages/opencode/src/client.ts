// Opencode HTTP client — spawns `opencode serve --port 0` once per backend
// instance and reuses the process across multiple prompt() calls (session
// per call, server kept alive). Disposed via dispose() when the backend
// is done.

import { type ChildProcess, spawn } from 'node:child_process' // @subprocess-ok: spawns opencode serve for HTTP backend
import { createOpencodeClient } from '@opencode-ai/sdk'
import type { AgentRequest, AgentResponse } from '@skelm/core'
import type { OpencodeBackendOptions } from './types.js'

type SdkClient = ReturnType<typeof createOpencodeClient>

export class OpencodeClientWrapper {
  private proc: ChildProcess | null = null
  private client: SdkClient | null = null
  private baseUrl: string | null = null
  private currentSessionId: string | null = null
  private startPromise: Promise<void> | null = null
  private _cancelled = false
  private readonly options: OpencodeBackendOptions

  constructor(options: OpencodeBackendOptions) {
    this.options = options
  }

  /**
   * Ensure the opencode server is running. Safe to call concurrently —
   * subsequent callers await the same start promise.
   */
  async ensureStarted(): Promise<void> {
    if (this.client !== null) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this._start()
    await this.startPromise
  }

  private async _start(): Promise<void> {
    const command = this.options.command ?? 'opencode'

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(command, ['serve', '--port', '0'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.proc = proc

      let resolved = false
      let buf = ''

      const tryParse = (chunk: Buffer) => {
        if (resolved) return
        buf += chunk.toString()
        // stdout: "opencode server listening on http://127.0.0.1:PORT"
        const m = buf.match(/listening on (https?:\/\/[^\s]+)/)
        if (m?.[1]) {
          resolved = true
          this.baseUrl = m[1].trim()
          this.client = createOpencodeClient({ baseUrl: this.baseUrl })
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
    // Server died unexpectedly — reset so next call restarts it
    this.proc = null
    this.client = null
    this.startPromise = null
  }

  /** For backward-compat with backend.ts which calls start() explicitly. */
  async start(): Promise<void> {
    return this.ensureStarted()
  }

  async prompt(request: AgentRequest, _permissions: unknown): Promise<AgentResponse> {
    await this.ensureStarted()
    if (!this.client) throw new Error('opencode serve not ready')

    const cwd = request.cwd ?? process.cwd()

    // Create a new session for this call (sessions are per-conversation)
    const sessResult = await this.client.session.create({ query: { directory: cwd } })
    if (!sessResult.data) {
      throw new Error(`session.create failed: ${JSON.stringify(sessResult.error)}`)
    }
    this.currentSessionId = sessResult.data.id
    const sessionId = this.currentSessionId

    // Build model spec: split "providerID/modelID"
    let modelBody: { model?: { providerID: string; modelID: string } } = {}
    if (this.options.model) {
      const slashIdx = this.options.model.indexOf('/')
      if (slashIdx > 0) {
        modelBody = {
          model: {
            providerID: this.options.model.slice(0, slashIdx),
            modelID: this.options.model.slice(slashIdx + 1),
          },
        }
      }
    }

    // session.prompt() returns the full AssistantMessage synchronously
    const result = await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        ...modelBody,
        parts: [{ type: 'text', text: request.prompt }],
      },
    })

    if (!result.data) {
      throw new Error(`session.prompt failed: ${JSON.stringify(result.error)}`)
    }

    // Extract text parts (skip synthetic/tool parts)
    let text = ''
    for (const part of result.data.parts as Array<{
      type: string
      text?: string
      synthetic?: boolean
    }>) {
      if (part.type === 'text' && !part.synthetic && part.text) {
        text += part.text
      }
    }

    return { text: text.trim(), stopReason: 'end_turn' }
  }

  async cancel(): Promise<void> {
    this._cancelled = true
    if (this.client && this.currentSessionId) {
      try {
        await this.client.session.abort({ path: { id: this.currentSessionId } })
      } catch {
        /* best effort */
      }
    }
  }

  /** Stop the opencode server and clean up. Called when the backend is no longer needed. */
  async dispose(): Promise<void> {
    this._cancelled = true
    this.proc?.kill('SIGTERM')
    this.proc = null
    this.client = null
    this.startPromise = null
    this.currentSessionId = null
  }

  getSessionId(): string | null {
    return this.currentSessionId
  }
}
