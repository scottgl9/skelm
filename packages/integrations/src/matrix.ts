import { IntegrationBase } from '@skelm/integration-sdk'
import type { MatrixConfig, MatrixMessageTrigger } from '@skelm/integration-sdk'
import { IntegrationApiError, IntegrationConfigError, IntegrationStateError } from './errors.js'

/**
 * Flat shape suitable for use as a pipeline input. Mirrors the runtime input
 * the example pipelines accept and is what the trigger source emits per inbound
 * room message.
 */
export interface MatrixMessageInput {
  roomId: string
  eventId: string
  sender: string
  body: string
}

interface MatrixTimelineEvent {
  type?: string
  event_id?: string
  sender?: string
  origin_server_ts?: number
  content?: { msgtype?: string; body?: string }
}

interface MatrixSyncResponse {
  next_batch?: string
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixTimelineEvent[] } }>
  }
}

/**
 * Extract the flat input shape from a Matrix `/sync` response. Walks the joined
 * rooms' timelines and keeps `m.text` messages only — `m.room.encrypted`, media
 * msgtypes, and state events are skipped. Events sent by `botUserId` are dropped
 * so the bot never reacts to its own messages (Matrix echoes them back in sync).
 */
export function matrixSyncToInputs(sync: unknown, botUserId?: string): MatrixMessageInput[] {
  const join = (sync as MatrixSyncResponse).rooms?.join
  if (join === undefined) return []
  const out: MatrixMessageInput[] = []
  for (const [roomId, room] of Object.entries(join)) {
    const events = room.timeline?.events
    if (events === undefined) continue
    for (const ev of events) {
      if (ev.type !== 'm.room.message' || ev.content?.msgtype !== 'm.text') continue
      if (
        typeof ev.event_id !== 'string' ||
        typeof ev.sender !== 'string' ||
        typeof ev.content.body !== 'string'
      ) {
        continue
      }
      if (botUserId !== undefined && ev.sender === botUserId) continue
      out.push({ roomId, eventId: ev.event_id, sender: ev.sender, body: ev.content.body })
    }
  }
  return out
}

/**
 * QueueDriver-shaped contract the trigger source returned from
 * `createTriggerSource()` satisfies. Declared structurally here so this file has
 * no dependency on @skelm/gateway.
 */
export interface MatrixTriggerSource {
  start(opts: {
    config?: Record<string, unknown>
    onMessage: (payload?: unknown) => Promise<void>
  }): Promise<void> | void
  stop(): Promise<void> | void
  onResult?(payload: unknown, output: unknown): Promise<void> | void
  /**
   * Receives every run event for the fired turn. Present only when
   * `streamReplies` is enabled; edits a placeholder message as `step.partial`
   * deltas arrive so the reply streams into the room live.
   */
  onEvent?(payload: unknown, event: unknown): Promise<void> | void
}

export interface CreateMatrixTriggerSourceOptions {
  /**
   * Skip the backlog of messages that arrived before the bot started by taking
   * one baseline sync and resuming from its token. Recommended after a gateway
   * restart, to avoid replying to stale messages. Default: true.
   */
  dropPending?: boolean
  /** Long-poll timeout for each `/sync` in milliseconds. Default: 30000. */
  syncTimeoutMs?: number
  /**
   * If true, the source's `onResult` posts `output.reply` back to the originating
   * room as a threaded reply. Default: true. The pipeline returns
   * `{ reply: string }` for the default behavior to apply.
   */
  postReply?: boolean
  /**
   * Who-can-talk allowlist by room id. When set, messages from any other room are
   * dropped before they fire a workflow. Omitted ⇒ no room restriction.
   *
   * SECURITY: an open inbound channel that drives a privileged (especially
   * unrestricted) agent lets anyone who finds the bot act as it. Set this (and/or
   * {@link allowedUsers}) whenever the target agent is not strictly sandboxed.
   */
  allowedRoomIds?: readonly string[]
  /**
   * Who-can-talk allowlist by sender user id (the `sender` field of
   * {@link MatrixMessageInput}, e.g. `@alice:example.org`). When set, messages from
   * any other sender are dropped. Combined with {@link allowedRoomIds} as AND:
   * every configured filter must pass.
   */
  allowedUsers?: readonly string[]
  /**
   * Stream the reply into the room as it is generated, instead of posting only
   * the final text. When true, the source edits a single placeholder message
   * (Matrix `m.replace`) as `step.partial` deltas arrive, and commits the final
   * `output.reply` into that same message on completion — so the room sees one
   * message that fills in live. Requires the workflow's backend to emit
   * `step.partial` events; with none, behavior is identical to a normal reply.
   * Default: false.
   */
  streamReplies?: boolean
  /**
   * Minimum gap between streamed message edits, in milliseconds, to avoid
   * hammering the homeserver on fast token streams. Default: 600.
   */
  streamThrottleMs?: number
}

export interface MatrixSendMessageOptions {
  roomId: string
  body: string
  /** Defaults to `m.text`. */
  msgtype?: string
  /** HTML body sent alongside the plain `body` (`org.matrix.custom.html`). */
  formattedBody?: string
  /** Event id to reply to (`m.in_reply_to`). */
  replyToEventId?: string
}

export interface MatrixSyncOptions {
  /** Resume token from a previous sync's `next_batch`. */
  since?: string
  /** Long-poll timeout in milliseconds. Default: 30000. */
  timeoutMs?: number
  /** Abort signal to cancel an in-flight long poll on shutdown. */
  signal?: AbortSignal
}

/**
 * Matrix Client-Server API integration (v3).
 *
 * A thin wrapper over the raw HTTP API: long-poll `/sync` to receive room
 * messages and `PUT .../send/m.room.message` to reply. Unencrypted rooms only —
 * `m.room.encrypted` events are skipped. Authenticates with a bot access token.
 */
export class MatrixIntegration extends IntegrationBase {
  readonly id = 'matrix' as const
  readonly name = 'Matrix'
  readonly capabilities = {
    canTrigger: true,
    canReceiveWebhooks: false,
    canPoll: true,
    canSendNotifications: true,
  }

  private baseUrl: string | null = null
  private accessToken: string | null = null
  private cachedUserId: string | null = null
  private txnCounter = 0
  declare config: MatrixConfig

  /** Override fetch — useful for tests. */
  private readonly fetchImpl: typeof fetch

  constructor(config: MatrixConfig, options: { fetch?: typeof fetch } = {}) {
    super(config)
    this.fetchImpl = options.fetch ?? fetch
  }

  protected async validateCredentials(): Promise<void> {
    const { homeserverUrl, accessToken, userId } = this.config.credentials
    if (typeof homeserverUrl !== 'string' || homeserverUrl.length === 0) {
      throw new IntegrationConfigError(
        'Matrix credentials missing: homeserverUrl required',
        this.id,
      )
    }
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new IntegrationConfigError('Matrix credentials missing: accessToken required', this.id)
    }
    this.baseUrl = `${homeserverUrl.replace(/\/+$/, '')}/_matrix/client/v3`
    this.accessToken = accessToken
    if (typeof userId === 'string' && userId.length > 0) {
      this.cachedUserId = userId
    }
  }

  protected async performHealthCheck(): Promise<boolean> {
    try {
      await this.whoami()
      return true
    } catch {
      return false
    }
  }

  /** Resolve the authenticated user id and device id. */
  async whoami(): Promise<{ userId: string; deviceId?: string }> {
    const r = await this.request<{ user_id: string; device_id?: string }>(
      'GET',
      '/account/whoami',
      {},
    )
    return {
      userId: r.user_id,
      ...(r.device_id !== undefined && { deviceId: r.device_id }),
    }
  }

  /**
   * The bot's own user id, used to filter its own messages out of sync. Taken
   * from `credentials.userId` when supplied, otherwise resolved via `/whoami`
   * and cached.
   */
  async getUserId(): Promise<string> {
    if (this.cachedUserId !== null) return this.cachedUserId
    const who = await this.whoami()
    this.cachedUserId = who.userId
    return who.userId
  }

  /**
   * Long-poll for new events. The caller tracks the next `since` token (from the
   * response's `next_batch`) and aborts on shutdown via `options.signal`.
   */
  async sync(options: MatrixSyncOptions = {}): Promise<MatrixSyncResponse> {
    return this.request<MatrixSyncResponse>('GET', '/sync', {
      query: {
        ...(options.since !== undefined && { since: options.since }),
        timeout: options.timeoutMs ?? 30000,
      },
      ...(options.signal !== undefined && { signal: options.signal }),
    })
  }

  /** Send a message to a room. Returns the sent event id. */
  async sendMessage(options: MatrixSendMessageOptions): Promise<{ eventId: string }> {
    const txnId = `m${Date.now()}.${this.txnCounter++}`
    const content: Record<string, unknown> = {
      msgtype: options.msgtype ?? 'm.text',
      body: options.body,
      ...(options.formattedBody !== undefined && {
        format: 'org.matrix.custom.html',
        formatted_body: options.formattedBody,
      }),
      ...(options.replyToEventId !== undefined && {
        'm.relates_to': { 'm.in_reply_to': { event_id: options.replyToEventId } },
      }),
    }
    const path = `/rooms/${encodeURIComponent(options.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`
    const r = await this.request<{ event_id: string }>('PUT', path, { body: content })
    return { eventId: r.event_id }
  }

  /**
   * Replace the body of a previously-sent message via the Matrix edit relation
   * (`m.replace`). Edit-aware clients render the new content in place; others
   * see the ` * <body>` fallback. Used to stream a reply into one message.
   */
  async editMessage(options: {
    roomId: string
    eventId: string
    body: string
    formattedBody?: string
  }): Promise<{ eventId: string }> {
    const txnId = `m${Date.now()}.${this.txnCounter++}`
    const newContent: Record<string, unknown> = {
      msgtype: 'm.text',
      body: options.body,
      ...(options.formattedBody !== undefined && {
        format: 'org.matrix.custom.html',
        formatted_body: options.formattedBody,
      }),
    }
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: ` * ${options.body}`,
      'm.new_content': newContent,
      'm.relates_to': { rel_type: 'm.replace', event_id: options.eventId },
    }
    const path = `/rooms/${encodeURIComponent(options.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`
    const r = await this.request<{ event_id: string }>('PUT', path, { body: content })
    return { eventId: r.event_id }
  }

  /**
   * Send a typing notification for the bot user in a room. `timeoutMs` is how
   * long the server should keep the bot marked as typing (ignored when
   * `typing` is false). Best-effort presence sugar for streamed replies.
   */
  async sendTyping(roomId: string, typing: boolean, timeoutMs = 20000): Promise<void> {
    const userId = await this.getUserId()
    const path = `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`
    await this.request('PUT', path, {
      body: typing ? { typing: true, timeout: timeoutMs } : { typing: false },
    })
  }

  /** Notification-style helper that matches the Integration interface. */
  async sendNotification(message: string, options?: { roomId?: string }): Promise<void> {
    const roomId = options?.roomId
    if (roomId === undefined || roomId === '') {
      throw new IntegrationConfigError(
        'Matrix sendNotification requires roomId in options',
        this.id,
      )
    }
    await this.sendMessage({ roomId, body: message })
  }

  /**
   * Convert a single raw `m.room.message` event (carrying `room_id`) into a
   * `MatrixMessageTrigger`. Returns null for non-text or non-message events.
   */
  async eventToRunInput(event: unknown): Promise<Record<string, unknown> | null> {
    const e = event as {
      type?: string
      event_id?: string
      room_id?: string
      sender?: string
      origin_server_ts?: number
      content?: { msgtype?: string; body?: string }
    }
    if (e.type !== 'm.room.message' || e.content?.msgtype !== 'm.text') return null
    if (
      typeof e.event_id !== 'string' ||
      typeof e.room_id !== 'string' ||
      typeof e.sender !== 'string' ||
      typeof e.content.body !== 'string'
    ) {
      return null
    }
    const trigger: MatrixMessageTrigger = {
      eventId: e.event_id,
      roomId: e.room_id,
      sender: e.sender,
      body: e.content.body,
      date: e.origin_server_ts ?? 0,
    }
    return { trigger: { type: 'matrix-message', ...trigger } }
  }

  /**
   * Build a queue-style trigger source that long-polls Matrix `/sync` and emits
   * one `onMessage(payload)` per inbound text message. The payload is a flat
   * `MatrixMessageInput` ready to use as a pipeline input.
   *
   * Register the returned object as a triggerSource in `skelm.config.ts`, then
   * have a pipeline declare `triggers: [{ kind: 'queue', sourceId: '<id>' }]`. The
   * gateway wires the rest — runs the workflow per message and (when `postReply`
   * is on) sends `output.reply` back to the room via `onResult`.
   */
  createTriggerSource(options: CreateMatrixTriggerSourceOptions = {}): MatrixTriggerSource {
    const dropPending = options.dropPending ?? true
    const syncTimeoutMs = options.syncTimeoutMs ?? 30000
    const postReply = options.postReply ?? true
    const streamReplies = options.streamReplies ?? false
    const streamThrottleMs = options.streamThrottleMs ?? 600
    const allowedRoomIds = options.allowedRoomIds
    const allowedUsers = options.allowedUsers
    const isAllowed = (input: MatrixMessageInput): boolean => {
      if (allowedRoomIds !== undefined && !allowedRoomIds.includes(input.roomId)) return false
      if (allowedUsers !== undefined && !allowedUsers.includes(input.sender)) return false
      return true
    }
    const integration = this
    let stopping = false
    let abortCtl: AbortController | null = null
    const seen = new Set<string>()
    // Per-inbound-message streaming state, keyed by the originating event id.
    const streams = new Map<
      string,
      { messageEventId?: string; text: string; lastEditAt: number; opening: boolean }
    >()
    let since: string | undefined
    let loopPromise: Promise<void> | null = null
    const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    const loop = async (onMessage: (payload?: unknown) => Promise<void>): Promise<void> => {
      // Resolve the bot's own id first — without it, echo filtering is off and the
      // bot would reply to its own posts. Retry until it resolves or we stop.
      let botUserId = ''
      while (!stopping && botUserId === '') {
        try {
          botUserId = await integration.getUserId()
        } catch {
          await delay(1000)
        }
      }
      if (stopping) return
      if (dropPending) {
        try {
          const initial = await integration.sync({ timeoutMs: 0 })
          since = initial.next_batch
        } catch {
          // best-effort
        }
      }
      while (!stopping) {
        abortCtl = new AbortController()
        let res: MatrixSyncResponse
        try {
          res = await integration.sync({
            ...(since !== undefined && { since }),
            timeoutMs: syncTimeoutMs,
            signal: abortCtl.signal,
          })
        } catch {
          if (stopping) break
          await delay(1000)
          continue
        }
        since = res.next_batch ?? since
        for (const input of matrixSyncToInputs(res, botUserId)) {
          if (stopping) break
          if (seen.has(input.eventId)) continue
          seen.add(input.eventId)
          // Who-can-talk gate: drop non-allowlisted senders/rooms before they can
          // fire a workflow (critical when the target agent is unrestricted).
          if (!isAllowed(input)) continue
          try {
            await onMessage(input)
          } catch {
            // Coordinator records lastError on its own; keep the loop alive.
          }
        }
      }
    }

    return {
      start({ onMessage }: { onMessage: (payload?: unknown) => Promise<void> }): void {
        stopping = false
        loopPromise = loop(onMessage)
      },
      async stop(): Promise<void> {
        stopping = true
        abortCtl?.abort()
        try {
          await loopPromise
        } catch {
          // ignore
        }
      },
      ...(streamReplies && {
        async onEvent(payload: unknown, event: unknown): Promise<void> {
          const input = payload as MatrixMessageInput | undefined
          const ev = event as { type?: string; delta?: unknown } | undefined
          if (input === undefined || ev?.type !== 'step.partial' || typeof ev.delta !== 'string') {
            return
          }
          let st = streams.get(input.eventId)
          if (st === undefined) {
            st = { text: '', lastEditAt: 0, opening: false }
            streams.set(input.eventId, st)
          }
          st.text += ev.delta
          if (st.text === '') return
          try {
            if (st.messageEventId === undefined) {
              // First delta opens the placeholder. Claim it synchronously
              // before the await: onEvent is dispatched with no back-pressure
              // (gateway fires `void onEvent(...)`), so deltas arriving during
              // this send would otherwise each post their own placeholder.
              // Racing deltas still accumulate into st.text and are flushed by
              // a later edit / the final commit, so nothing is lost.
              if (st.opening) return
              st.opening = true
              const sent = await integration.sendMessage({
                roomId: input.roomId,
                body: st.text,
                replyToEventId: input.eventId,
              })
              st.messageEventId = sent.eventId
              st.lastEditAt = Date.now()
              st.opening = false
            } else {
              const now = Date.now()
              if (now - st.lastEditAt >= streamThrottleMs) {
                st.lastEditAt = now
                await integration.editMessage({
                  roomId: input.roomId,
                  eventId: st.messageEventId,
                  body: st.text,
                })
              }
            }
          } catch {
            // Best-effort streaming; onResult still commits the final reply.
            // Release the open-claim so a later delta can retry the placeholder
            // if the first send failed.
            st.opening = false
          }
        },
      }),
      ...(postReply && {
        async onResult(payload: unknown, output: unknown): Promise<void> {
          const input = payload as MatrixMessageInput | undefined
          const reply = (output as { reply?: unknown } | undefined)?.reply
          const st = input !== undefined ? streams.get(input.eventId) : undefined
          if (input === undefined || typeof reply !== 'string' || reply === '') {
            if (input !== undefined) streams.delete(input.eventId)
            return
          }
          try {
            if (st?.messageEventId !== undefined) {
              // We streamed a placeholder — commit the final text into that same
              // message rather than posting a duplicate reply.
              await integration.editMessage({
                roomId: input.roomId,
                eventId: st.messageEventId,
                body: reply,
              })
            } else {
              await integration.sendMessage({
                roomId: input.roomId,
                body: reply,
                replyToEventId: input.eventId,
              })
            }
          } catch {
            // best-effort; gateway audit will record the run, the loop continues.
          } finally {
            if (input !== undefined) streams.delete(input.eventId)
          }
        },
      }),
    }
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number>; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    if (this.accessToken === null || this.baseUrl === null) {
      throw new IntegrationStateError(
        'MatrixIntegration not initialized — call init() first',
        this.id,
      )
    }
    const url = new URL(`${this.baseUrl}${path}`)
    if (opts.query !== undefined) {
      for (const [k, v] of Object.entries(opts.query)) {
        url.searchParams.set(k, String(v))
      }
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.accessToken}` }
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const res = await this.fetchImpl(url, {
      method,
      headers,
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
    })
    const json = (await res.json()) as T & { errcode?: string; error?: string }
    if (!res.ok) {
      throw new IntegrationApiError(
        `Matrix API ${path} failed: ${json.error ?? json.errcode ?? `HTTP ${res.status}`}`,
        this.id,
        res.status,
        { cause: json },
      )
    }
    return json
  }
}
