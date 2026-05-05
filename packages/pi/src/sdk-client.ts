/**
 * Thin wrapper around the pi coding agent SDK for programmatic use.
 *
 * Uses `createAgentSession` from `@mariozechner/pi-coding-agent` to spin up
 * a pi session with an explicit tool allowlist, sends one prompt, and collects
 * the result from the `agent_end` event.
 */

export interface PiSdkClientOptions {
  /** Working directory for pi's project-local discovery. Default: process.cwd() */
  cwd?: string
  /**
   * Allowlist of tool names enabled for this session.
   * When omitted pi enables its default built-in tools (bash, read, edit, write).
   * When provided, only the listed names are active.
   * Pass an empty array with noTools:'all' to disable all tools.
   */
  tools?: string[]
  /** Suppress all built-in tools when no explicit allowlist covers them. */
  noTools?: 'all' | 'builtin'
}

export interface PiSdkResponse {
  text: string
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  usage?: { inputTokens: number; outputTokens: number }
}

export class PiSdkClient {
  constructor(private readonly opts: PiSdkClientOptions = {}) {}

  async prompt(text: string, signal?: AbortSignal, timeoutMs = 300_000): Promise<PiSdkResponse> {
    // Dynamic import so the package remains optional at runtime
    const { createAgentSession } = await import('@mariozechner/pi-coding-agent').catch(() => {
      throw new Error(
        'pi SDK not installed. Add @mariozechner/pi-coding-agent to your project: npm install @mariozechner/pi-coding-agent',
      )
    })

    const { SessionManager } = await import('@mariozechner/pi-coding-agent')

    const { session } = await createAgentSession({
      ...(this.opts.cwd !== undefined && { cwd: this.opts.cwd }),
      sessionManager: SessionManager.inMemory(),
      ...(this.opts.tools !== undefined && { tools: this.opts.tools }),
      ...(this.opts.noTools !== undefined && { noTools: this.opts.noTools }),
    })

    try {
      return await this._run(session, text, signal, timeoutMs)
    } finally {
      session.dispose()
    }
  }

  private _run(
    session: import('@mariozechner/pi-coding-agent').AgentSession,
    text: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<PiSdkResponse> {
    return new Promise<PiSdkResponse>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        fn()
      }

      const timer = setTimeout(() => {
        settle(() => {
          session.abort().catch(() => {})
          reject(new Error(`pi agent timed out after ${timeoutMs}ms`))
        })
      }, timeoutMs)

      const onAbort = () => {
        settle(() => {
          session.abort().catch(() => {})
          reject(new Error('pi agent aborted'))
        })
      }

      if (signal?.aborted) {
        clearTimeout(timer)
        reject(new Error('pi agent aborted'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const unsub = session.subscribe((event) => {
        if (event.type === 'agent_end') {
          unsub()
          settle(() => {
            const assistantMsg = [...event.messages].reverse().find((m) => m.role === 'assistant')

            if (!assistantMsg || assistantMsg.role !== 'assistant') {
              resolve({ text: '', stopReason: 'stop' })
              return
            }

            const text = assistantMsg.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('')

            resolve({
              text,
              stopReason: assistantMsg.stopReason as PiSdkResponse['stopReason'],
              usage: {
                inputTokens: assistantMsg.usage.input,
                outputTokens: assistantMsg.usage.output,
              },
            })
          })
        }
      })

      session.prompt(text).catch((err: unknown) => {
        unsub()
        settle(() => reject(err))
      })
    })
  }
}
