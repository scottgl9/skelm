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
  /** Timeout (ms) for the turn's run to start before submit rejects. Default: 30_000. */
  startTimeoutMs?: number
  /**
   * UI frontend factory the CLI host should render. The gateway never invokes
   * it (this source is headless); it's carried here so a project can declare its
   * terminal UI in `skelm.config.*` and `skelm run` picks it up over the bridge.
   */
  frontend?: TuiFrontendFactory
}

/**
 * A headless TUI trigger source for the gateway side of a split UI. Unlike
 * {@link TuiIntegration.createTriggerSource}, it builds NO frontend — the
 * terminal UI lives in the `skelm run` CLI process. The gateway registers this
 * as the project's queue driver; the CLI POSTs each user line to
 * `/v1/tui/:sourceId/submit`, which calls {@link submit} here. submit fires the
 * workflow and resolves with the turn's `runId` (captured from the first run
 * event); the CLI then tails `/runs/:runId/stream` for partials and the reply.
 */
export interface RemoteTuiTriggerSource extends TuiTriggerSource {
  /** Discriminator the gateway uses to tag this source as CLI-hosted. */
  readonly transport: 'tui'
  /** Optional UI frontend factory for the CLI host to render. */
  readonly frontend?: TuiFrontendFactory
  /** Receives every run event for the fired turn; used to capture the runId. */
  onEvent(payload: unknown, event: unknown): void
  /** Inject one user line; resolves with the turn's runId once the run starts. */
  submit(input: { sessionId: string; text: string; from?: string }): Promise<{ runId: string }>
}

export function createRemoteTriggerSource(
  options: CreateRemoteTuiTriggerSourceOptions = {},
): RemoteTuiTriggerSource {
  const defaultFrom = options.from ?? 'you'
  const startTimeoutMs = options.startTimeoutMs ?? 30_000
  let onMessage: ((payload?: unknown) => Promise<void>) | null = null
  let seq = 0
  const pending = new Map<
    number,
    { resolve: (r: { runId: string }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()

  return {
    transport: 'tui',
    ...(options.frontend !== undefined && { frontend: options.frontend }),
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
    onEvent(payload: unknown, event: unknown): void {
      // The first event for a turn carries its runId; hand it to the waiting
      // submit so the CLI can subscribe to the run stream for partials + reply.
      const s = (payload as { seq?: unknown } | undefined)?.seq
      const runId = (event as { runId?: unknown } | undefined)?.runId
      if (typeof s !== 'number' || typeof runId !== 'string') return
      const entry = pending.get(s)
      if (entry === undefined) return
      clearTimeout(entry.timer)
      pending.delete(s)
      entry.resolve({ runId })
    },
    async submit(input: {
      sessionId: string
      text: string
      from?: string
    }): Promise<{ runId: string }> {
      if (onMessage === null) throw new Error('tui source not started')
      seq += 1
      const mySeq = seq
      const payload: TuiMessageInput = {
        sessionId: input.sessionId,
        from: input.from ?? defaultFrom,
        text: input.text,
        seq: mySeq,
      }
      const runId = new Promise<{ runId: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(mySeq)
          reject(new Error('tui turn did not start'))
        }, startTimeoutMs)
        timer.unref?.()
        pending.set(mySeq, { resolve, reject, timer })
      })
      // Fire without awaiting: a non-parallel trigger blocks onMessage until the
      // run completes, but we resolve on the first event (run start) so the CLI
      // can tail live partials.
      void Promise.resolve(onMessage(payload)).catch((err: unknown) => {
        const entry = pending.get(mySeq)
        if (entry !== undefined) {
          clearTimeout(entry.timer)
          pending.delete(mySeq)
          entry.reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
      return runId
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
