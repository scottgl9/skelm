import { IntegrationBase } from '@skelm/integration-sdk'
import type { TuiConfig } from '@skelm/integration-sdk'

/**
 * Flat shape emitted per inbound line, suitable as a pipeline input or a
 * persistent-workflow payload. `sessionId` is the natural `sessionKey` so a TUI
 * session is one durable conversation.
 */
export interface TuiMessageInput {
  /** Stable conversation id for this terminal session. */
  sessionId: string
  /** Display name of the local user. */
  from: string
  /** The line the user submitted (trimmed). */
  text: string
  /** Monotonic per-source sequence number, 1-based. */
  seq: number
}

/**
 * The mechanism's side of the bridge, handed to the frontend factory. The
 * frontend calls `submit()` whenever the user enters a line; the integration
 * turns it into a trigger fire.
 */
export interface TuiFrontendIo {
  /** Submit a user line. Blank input is ignored. */
  submit(text: string): void
}

/**
 * A UI frontend. The integration owns none of the rendering — a frontend (e.g.
 * the `tui-assistant` example, built on a terminal-UI library) implements this
 * and is wired in via {@link CreateTuiTriggerSourceOptions.frontend}.
 */
export interface TuiFrontend {
  /** Render a reply the workflow posted back for `payload`. */
  render(reply: string, payload: TuiMessageInput): void
  /** Tear down the UI on shutdown. */
  close?(): void | Promise<void>
}

/**
 * Builds a {@link TuiFrontend} given the bridge `io`. Called once when the
 * trigger source starts. This is the seam: the UI implementation lives wherever
 * the factory is defined (the example), never in this package.
 */
export type TuiFrontendFactory = (io: TuiFrontendIo) => TuiFrontend

/**
 * QueueDriver-shaped contract the trigger source returned from
 * `createTriggerSource()` satisfies. Declared structurally here so this file
 * has no dependency on @skelm/gateway (mirrors {@link TelegramTriggerSource}).
 */
export interface TuiTriggerSource {
  start(opts: {
    config?: Record<string, unknown>
    onMessage: (payload?: unknown) => Promise<void>
  }): Promise<void> | void
  stop(): Promise<void> | void
  onResult?(payload: unknown, output: unknown): Promise<void> | void
}

export interface CreateTuiTriggerSourceOptions {
  /** Factory for the UI frontend that drives this source. Required. */
  frontend: TuiFrontendFactory
  /** Conversation id emitted on every message. Default: `'tui'`. */
  sessionId?: string
  /** Display name of the local user. Default: `'you'`. */
  from?: string
  /**
   * If true, the source's `onResult` forwards `output.reply` to the frontend's
   * `render`. Default: true. A persistent workflow / pipeline returns
   * `{ reply: string }` for the default behavior to apply.
   */
  postReply?: boolean
}

/**
 * Terminal-UI integration — the *mechanism* for driving a workflow from a local
 * UI, not a UI itself.
 *
 * It bridges a pluggable {@link TuiFrontend} to the gateway's queue-driver
 * contract: the frontend calls `io.submit(text)` per user line (→ one
 * `onMessage` fire), and the integration forwards each reply back to the
 * frontend's `render` via `onResult`. The actual terminal rendering lives in the
 * frontend (see the `tui-assistant` example), which can be built on any
 * terminal-UI library. Needs no credentials; it binds to a local frontend
 * rather than a remote service.
 */
export interface CreateRemoteTuiTriggerSourceOptions {
  /** Display name of the local user. Default: `'you'`. */
  from?: string
  /** Per-turn reply timeout in ms. Default: 120_000. */
  replyTimeoutMs?: number
}

/**
 * A headless TUI trigger source for the gateway side of a split UI. Unlike
 * {@link TuiIntegration.createTriggerSource}, it builds NO frontend — the
 * terminal UI lives in the `skelm run` CLI process. The gateway registers this
 * as the project's queue driver; the CLI POSTs each user line to
 * `/v1/tui/:sourceId/submit`, which calls {@link submit} here. submit fires the
 * workflow with a {@link TuiMessageInput} and resolves with the turn's reply,
 * correlated by the per-source `seq` echoed back through {@link onResult}.
 */
export interface RemoteTuiTriggerSource extends TuiTriggerSource {
  /** Discriminator the gateway uses to tag this source as CLI-hosted. */
  readonly transport: 'tui'
  /** Inject one user line and resolve with the workflow's reply. */
  submit(input: { sessionId: string; text: string; from?: string }): Promise<{ reply: string }>
}

export function createRemoteTriggerSource(
  options: CreateRemoteTuiTriggerSourceOptions = {},
): RemoteTuiTriggerSource {
  const defaultFrom = options.from ?? 'you'
  const replyTimeoutMs = options.replyTimeoutMs ?? 120_000
  let onMessage: ((payload?: unknown) => Promise<void>) | null = null
  let seq = 0
  const pending = new Map<
    number,
    { resolve: (r: { reply: string }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()

  return {
    transport: 'tui',
    start({ onMessage: fn }): void {
      onMessage = fn
      seq = 0
    },
    stop(): void {
      onMessage = null
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('tui source stopped'))
      }
      pending.clear()
    },
    onResult(payload: unknown, output: unknown): void {
      const s = (payload as { seq?: unknown } | undefined)?.seq
      if (typeof s !== 'number') return
      const entry = pending.get(s)
      if (entry === undefined) return
      clearTimeout(entry.timer)
      pending.delete(s)
      const reply = (output as { reply?: unknown } | undefined)?.reply
      entry.resolve({ reply: typeof reply === 'string' ? reply : '' })
    },
    async submit(input: {
      sessionId: string
      text: string
      from?: string
    }): Promise<{ reply: string }> {
      if (onMessage === null) throw new Error('tui source not started')
      seq += 1
      const mySeq = seq
      const payload: TuiMessageInput = {
        sessionId: input.sessionId,
        from: input.from ?? defaultFrom,
        text: input.text,
        seq: mySeq,
      }
      const result = new Promise<{ reply: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(mySeq)
          reject(new Error('tui turn timed out'))
        }, replyTimeoutMs)
        timer.unref?.()
        pending.set(mySeq, { resolve, reject, timer })
      })
      await onMessage(payload)
      return result
    },
  }
}

export class TuiIntegration extends IntegrationBase {
  readonly id = 'tui' as const
  readonly name = 'Terminal UI'
  readonly capabilities = {
    canTrigger: true,
    canReceiveWebhooks: false,
    canPoll: false,
    canSendNotifications: false,
  }

  declare config: TuiConfig

  protected async validateCredentials(): Promise<void> {
    // The TUI binds to a local frontend; it needs no credentials.
  }

  protected async performHealthCheck(): Promise<boolean> {
    return true
  }

  /**
   * Build a queue-style trigger source bridging a UI frontend to the gateway.
   *
   * Register the returned object as a triggerSource in `skelm.config.ts`, then
   * have a workflow declare `triggers: [{ kind: 'queue', sourceId: '<id>' }]`
   * (or a persistent workflow with `agent.sessionKey: (m) => m.sessionId`). When the
   * gateway starts the source it builds the frontend; each `io.submit(line)`
   * fires the workflow with a flat {@link TuiMessageInput}, and (when
   * `postReply` is on) each `output.reply` is rendered back via the frontend.
   */
  createTriggerSource(options: CreateTuiTriggerSourceOptions): TuiTriggerSource {
    const frontend = options.frontend
    const sessionId = options.sessionId ?? 'tui'
    const from = options.from ?? 'you'
    const postReply = options.postReply ?? true

    let ui: TuiFrontend | null = null
    let seq = 0

    return {
      start({ onMessage }: { onMessage: (payload?: unknown) => Promise<void> }): void {
        seq = 0
        ui = frontend({
          submit: (text: string): void => {
            const trimmed = text.trim()
            if (trimmed === '') return
            seq += 1
            void onMessage({ sessionId, from, text: trimmed, seq })
          },
        })
      },
      async stop(): Promise<void> {
        await ui?.close?.()
        ui = null
      },
      ...(postReply && {
        async onResult(payload: unknown, output: unknown): Promise<void> {
          const reply = (output as { reply?: unknown } | undefined)?.reply
          if (typeof reply === 'string' && reply !== '') {
            ui?.render(reply, payload as TuiMessageInput)
          }
        },
      }),
    }
  }
}
