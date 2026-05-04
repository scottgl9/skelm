// Opencode HTTP client — spawns `opencode serve --port 0`, connects via
// @opencode-ai/sdk, and uses the synchronous session.prompt response.
//
// session.prompt() returns the full AssistantMessage synchronously once the
// model finishes — no SSE needed for response collection.

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
  private _cancelled = false
  private readonly options: OpencodeBackendOptions

  constructor(options: OpencodeBackendOptions) {
    this.options = options
  }

  /** Spawn `opencode serve --port 0` and wait until it logs its listening URL. */
  async start(): Promise<void> {
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
      })
      proc.once('exit', (code) => {
        if (!resolved) reject(new Error(`opencode serve exited with code ${code}`))
      })
      setTimeout(() => {
        if (!resolved) reject(new Error('opencode serve: timed out waiting for port'))
      }, 15_000)
    })
  }

  async prompt(request: AgentRequest, _permissions: unknown): Promise<AgentResponse> {
    if (!this.client) throw new Error('not started — call start() first')

    const cwd = request.cwd ?? process.cwd()

    // Create a session, passing model if configured
    const sessResult = await this.client.session.create({ query: { directory: cwd } })
    if (!sessResult.data) {
      throw new Error(`session.create failed: ${JSON.stringify(sessResult.error)}`)
    }
    this.currentSessionId = sessResult.data.id
    const sessionId = this.currentSessionId

    // Build model spec: split "providerID/modelID" or use as-is
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

    // session.prompt() is synchronous — returns the full assistant message once done.
    // The response includes `parts: Part[]`; collect text parts for the final text.
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

    // Extract text from response parts (skip synthetic/tool parts)
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

  async dispose(): Promise<void> {
    this._cancelled = true
    this.proc?.kill('SIGTERM')
    this.proc = null
    this.client = null
    this.currentSessionId = null
  }

  getSessionId(): string | null {
    return this.currentSessionId
  }
}
