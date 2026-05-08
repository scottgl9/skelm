/**
 * Thin wrapper around the pi coding agent SDK for programmatic use.
 *
 * Uses createAgentSessionServices + createAgentSessionFromServices so we can
 * pass resource-loader options (system prompt, skill/extension suppression)
 * that createAgentSession does not expose directly.
 */

export interface PiSdkPromptOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onPartial?: (delta: string) => void
}

export interface PiSdkClientOptions {
  /** Working directory for pi's project-local discovery. Default: process.cwd() */
  cwd?: string
  /**
   * Allowlist of tool names enabled for this session.
   * When omitted pi enables its default built-in tools (bash, read, edit, write).
   * When provided, only the listed names are active.
   */
  tools?: string[]
  /** Suppress built-in tools when no allowlist covers them. */
  noTools?: 'all' | 'builtin'
  /**
   * Content injected into pi's system prompt.
   * When replaceSystemPrompt is false (default), appended after pi's base prompt.
   * When replaceSystemPrompt is true, replaces pi's base prompt entirely.
   */
  system?: string
  /**
   * When true, system replaces pi's base system prompt instead of appending.
   * Default: false — pi's coding-agent prompt stays active; system is appended.
   */
  replaceSystemPrompt?: boolean
  /**
   * Disable pi's built-in skill loading from .pi/skills/ directories.
   * Default: true — skelm injects skills itself via formatSkillBlock; loading
   * pi's own skills would cause duplicates.
   */
  noSkills?: boolean
  /**
   * Disable pi's extension loading from .pi/extensions/.
   * Default: true — extensions can register additional tools and modify behaviour
   * in ways skelm cannot audit; disable by default for predictable sandboxing.
   */
  noExtensions?: boolean
  /**
   * Disable pi's cwd context file discovery (AGENTS.md, .pi/context/).
   * Default: false — project context files are useful and safe.
   */
  noContextFiles?: boolean
}

export interface PiSdkResponse {
  text: string
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  usage?: { inputTokens: number; outputTokens: number }
}

/**
 * Thrown by `PiSdkClient.prompt` when pi terminates with a non-success
 * stopReason ('error' or 'aborted' from the provider side). Carries the
 * upstream `errorMessage` from pi's final assistant message so callers can
 * surface a useful diagnostic (rate limits, 401s, network failures, …).
 */
export class PiSdkUpstreamError extends Error {
  override readonly name = 'PiSdkUpstreamError'
  constructor(
    message: string,
    /** The stopReason pi reported on the final assistant message. */
    readonly stopReason: 'error' | 'aborted',
    /** The raw `errorMessage` field from pi's assistant message, if present. */
    readonly upstreamErrorMessage?: string,
  ) {
    super(message)
  }
}

export class PiSdkClient {
  constructor(private readonly opts: PiSdkClientOptions = {}) {}

  async prompt(
    text: string,
    signal?: AbortSignal,
    timeoutMs?: number,
    onPartial?: (delta: string) => void,
  ): Promise<PiSdkResponse> {
    // Dynamic import keeps @mariozechner/pi-coding-agent optional at runtime
    const pi = await import('@mariozechner/pi-coding-agent').catch(() => {
      throw new Error(
        'pi SDK not installed. Add @mariozechner/pi-coding-agent to your project: npm install @mariozechner/pi-coding-agent',
      )
    })

    const { createAgentSessionServices, createAgentSessionFromServices, SessionManager } = pi

    const cwd = this.opts.cwd ?? process.cwd()

    const systemPromptOverride =
      this.opts.system !== undefined
        ? (base: string | undefined): string | undefined =>
            this.opts.replaceSystemPrompt
              ? this.opts.system
              : [base, this.opts.system].filter(Boolean).join('\n\n')
        : undefined

    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: {
        noSkills: this.opts.noSkills ?? true,
        noExtensions: this.opts.noExtensions ?? true,
        ...(this.opts.noContextFiles && { noContextFiles: true }),
        ...(systemPromptOverride !== undefined && { systemPromptOverride }),
      },
    })

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(),
      ...(this.opts.tools !== undefined && { tools: this.opts.tools }),
      ...(this.opts.noTools !== undefined && { noTools: this.opts.noTools }),
    })

    try {
      return await this._run(session, text, signal, timeoutMs ?? 300_000, onPartial)
    } finally {
      session.dispose()
    }
  }

  private _run(
    session: import('@mariozechner/pi-coding-agent').AgentSession,
    text: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onPartial?: (delta: string) => void,
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

      // Track accumulated text per message for delta calculation
      const partialTextByMsg = new Map<string, string>()

      const unsub = session.subscribe((event) => {
        // Forward partial text deltas if onPartial is provided.
        // pi emits 'message_update' events during streaming with updated content arrays.
        if (onPartial !== undefined && event.type === 'message_update') {
          const msg = event.message as {
            role?: string
            content?: Array<{ type: string; text: string }>
          }
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const fullText = msg.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('')
            const msgId = (event as { messageId?: string }).messageId ?? 'default'
            const prev = partialTextByMsg.get(msgId) ?? ''
            if (fullText.length > prev.length) {
              onPartial(fullText.slice(prev.length))
              partialTextByMsg.set(msgId, fullText)
            }
          }
        }
        if (event.type === 'agent_end') {
          unsub()
          settle(() => {
            const assistantMsg = [...event.messages].reverse().find((m) => m.role === 'assistant')

            if (!assistantMsg || assistantMsg.role !== 'assistant') {
              // pi terminated without producing an assistant message. This is
              // not a successful "empty stop" — surface it as a real error so
              // the runner can mark the step failed instead of silently
              // recording a completed step with empty text.
              reject(
                new PiSdkUpstreamError(
                  'pi agent terminated without producing an assistant message',
                  'error',
                ),
              )
              return
            }

            // pi-coding-agent embeds upstream provider errors (rate limits,
            // 401s, network failures, model-side aborts, …) into the final
            // assistant message with stopReason: 'error' or 'aborted' and an
            // optional `errorMessage` field. Without this guard the SDK would
            // resolve `{ text: '', stopReason: 'error' }` which the runner
            // records as `status: completed` — masquerading as success.
            // Promote those terminal stopReasons to a thrown error.
            if (assistantMsg.stopReason === 'error' || assistantMsg.stopReason === 'aborted') {
              const detail =
                typeof (assistantMsg as { errorMessage?: unknown }).errorMessage === 'string'
                  ? (assistantMsg as { errorMessage: string }).errorMessage
                  : undefined
              const apiTag =
                'provider' in assistantMsg && 'model' in assistantMsg
                  ? ` (provider=${(assistantMsg as { provider?: string }).provider ?? '?'}, model=${(assistantMsg as { model?: string }).model ?? '?'})`
                  : ''
              const headline =
                assistantMsg.stopReason === 'aborted'
                  ? `pi inference aborted${apiTag}`
                  : `pi inference failed${apiTag}`
              reject(
                new PiSdkUpstreamError(
                  detail !== undefined && detail.length > 0 ? `${headline}: ${detail}` : headline,
                  assistantMsg.stopReason,
                  detail,
                ),
              )
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
