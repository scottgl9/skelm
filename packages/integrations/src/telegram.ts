import { IntegrationBase } from './base.js'
import type { TelegramConfig, TelegramMessageTrigger, TelegramWebhookEvent } from './types.js'

/**
 * Flat shape suitable for use as a pipeline input. Mirrors the runtime
 * input the example pipelines accept and is what the trigger source emits
 * per inbound update.
 */
export interface TelegramMessageInput {
  updateId: number
  messageId: number
  chatId: string
  from: string
  text: string
}

/**
 * Convert a raw Telegram update into the flat input shape pipelines
 * consume. Returns null for updates that don't carry text content (those
 * are skipped by the trigger source).
 */
export function telegramUpdateToInput(update: unknown): TelegramMessageInput | null {
  const u = update as { update_id?: number; message?: Record<string, unknown> }
  const msg = u.message
  if (
    msg === undefined ||
    typeof u.update_id !== 'number' ||
    typeof msg.message_id !== 'number' ||
    typeof msg.text !== 'string'
  ) {
    return null
  }
  const chat = msg.chat as { id: number | string }
  const from = msg.from as { username?: string; first_name?: string; id?: number } | undefined
  return {
    updateId: u.update_id,
    messageId: msg.message_id as number,
    chatId: String(chat.id),
    from: from?.username ?? from?.first_name ?? 'user',
    text: msg.text,
  }
}

/**
 * QueueDriver-shaped contract the trigger source returned from
 * `createTriggerSource()` satisfies. Declared structurally here so this
 * file has no dependency on @skelm/gateway.
 */
export interface TelegramTriggerSource {
  start(opts: {
    config?: Record<string, unknown>
    onMessage: (payload?: unknown) => Promise<void>
  }): Promise<void> | void
  stop(): Promise<void> | void
  onResult?(payload: unknown, output: unknown): Promise<void> | void
}

export interface CreateTelegramTriggerSourceOptions {
  /**
   * Drop any pending updates queued before the bot started. Recommended
   * when the gateway is restarted, to avoid replying to stale messages.
   * Default: true.
   */
  dropPending?: boolean
  /** Long-poll timeout in seconds. Default: 25. */
  longPollSeconds?: number
  /**
   * `allowed_updates` forwarded to getUpdates(). Default: `['message']`.
   */
  allowedUpdates?: string[]
  /**
   * If true, the source's `onResult` posts `output.reply` back to the
   * originating chat. Default: true. The pipeline returns
   * `{ reply: string }` for the default behavior to apply.
   */
  postReply?: boolean
}

const TELEGRAM_API_BASE = 'https://api.telegram.org'

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

interface TelegramRawMessage {
  message_id: number
  chat: { id: number | string; type?: string; title?: string; username?: string }
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string }
  date: number
  text?: string
  entities?: Array<{ type: string; offset: number; length: number }>
}

interface TelegramRawUpdate {
  update_id: number
  message?: TelegramRawMessage
  edited_message?: TelegramRawMessage
  callback_query?: unknown
}

export interface TelegramSendMessageOptions {
  chatId: number | string
  text: string
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'
  replyToMessageId?: number
  disableWebPagePreview?: boolean
}

export interface TelegramGetUpdatesOptions {
  offset?: number
  limit?: number
  /** Long-poll timeout in seconds. 0 = short poll. */
  timeoutSeconds?: number
  allowedUpdates?: string[]
  /** Abort signal to cancel an in-flight long poll on shutdown. */
  signal?: AbortSignal
}

/**
 * Telegram Bot API integration.
 *
 * Supports both webhook and long-poll delivery. Webhooks call
 * eventToRunInput() to convert an incoming Update into a
 * TelegramMessageTrigger; long pollers consume getUpdates() directly.
 */
export class TelegramIntegration extends IntegrationBase {
  readonly id = 'telegram' as const
  readonly name = 'Telegram'
  readonly capabilities = {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: true,
    canSendNotifications: true,
  }

  private botToken: string | null = null
  declare config: TelegramConfig

  /** Override fetch — useful for tests. */
  private readonly fetchImpl: typeof fetch

  constructor(config: TelegramConfig, options: { fetch?: typeof fetch } = {}) {
    super(config)
    this.fetchImpl = options.fetch ?? fetch
  }

  protected async validateCredentials(): Promise<void> {
    const token = this.config.credentials.botToken
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('Telegram credentials missing: botToken required')
    }
    // Format: <bot_id>:<35-char-secret>. Reject obvious mistakes early.
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
      throw new Error('Invalid Telegram bot token format')
    }
    this.botToken = token
  }

  protected async performHealthCheck(): Promise<boolean> {
    try {
      await this.getMe()
      return true
    } catch {
      return false
    }
  }

  protected async setupWebhook(): Promise<void> {
    const webhook = this.config.webhook
    if (!webhook) return
    const url = (this.config.credentials as { webhookUrl?: string }).webhookUrl
    if (typeof url !== 'string' || url.length === 0) return
    const secret = webhook.secret
    await this.callApi('setWebhook', {
      url,
      ...(secret !== undefined && { secret_token: secret }),
      ...(webhook.events.length > 0 && { allowed_updates: webhook.events }),
    })
  }

  protected async cleanupWebhook(): Promise<void> {
    if (!this.config.webhook) return
    try {
      await this.callApi('deleteWebhook', {})
    } catch {
      // best-effort on shutdown
    }
  }

  /**
   * Verify the X-Telegram-Bot-Api-Secret-Token header against the configured
   * webhook secret. Returns false on mismatch or missing config.
   */
  verifyWebhookSecret(headerSecret: string | undefined): boolean {
    const expected = this.config.webhook?.secret
    if (typeof expected !== 'string' || expected.length === 0) return false
    if (typeof headerSecret !== 'string' || headerSecret.length === 0) return false
    if (expected.length !== headerSecret.length) return false
    let mismatch = 0
    for (let i = 0; i < expected.length; i++) {
      mismatch |= expected.charCodeAt(i) ^ headerSecret.charCodeAt(i)
    }
    return mismatch === 0
  }

  async eventToRunInput(event: unknown): Promise<Record<string, unknown> | null> {
    const update = event as TelegramWebhookEvent & TelegramRawUpdate
    const msg = update.message ?? update.edited_message
    if (!msg || typeof (msg as TelegramRawMessage).message_id !== 'number') {
      return null
    }
    const m = msg as TelegramRawMessage
    const trigger: TelegramMessageTrigger = {
      messageId: m.message_id,
      chatId: String(m.chat.id),
      from: m.from?.username ?? m.from?.first_name ?? String(m.from?.id ?? ''),
      ...(m.text !== undefined && { text: m.text }),
      ...(m.entities !== undefined && { entities: m.entities }),
      date: m.date,
    }
    return {
      trigger: { type: 'telegram-message', ...trigger, updateId: update.update_id },
    }
  }

  /** Send a message. Returns the sent message id. */
  async sendMessage(options: TelegramSendMessageOptions): Promise<{ messageId: number }> {
    const result = await this.callApi<TelegramRawMessage>('sendMessage', {
      chat_id: options.chatId,
      text: options.text,
      ...(options.parseMode !== undefined && { parse_mode: options.parseMode }),
      ...(options.replyToMessageId !== undefined && {
        reply_to_message_id: options.replyToMessageId,
      }),
      ...(options.disableWebPagePreview !== undefined && {
        disable_web_page_preview: options.disableWebPagePreview,
      }),
    })
    return { messageId: result.message_id }
  }

  /** Notification-style helper that matches the Integration interface. */
  async sendNotification(
    message: string,
    options?: { chatId?: number | string; parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' },
  ): Promise<void> {
    const chatId = options?.chatId ?? this.config.credentials.chatId
    if (chatId === undefined || chatId === '') {
      throw new Error('Telegram sendNotification requires chatId in options or config.credentials')
    }
    await this.sendMessage({
      chatId,
      text: message,
      ...(options?.parseMode !== undefined && { parseMode: options.parseMode }),
    })
  }

  async sendChatAction(chatId: number | string, action: 'typing'): Promise<void> {
    await this.callApi('sendChatAction', { chat_id: chatId, action })
  }

  async getMe(): Promise<{ id: number; username?: string; firstName?: string }> {
    const r = await this.callApi<{ id: number; username?: string; first_name?: string }>(
      'getMe',
      {},
    )
    return {
      id: r.id,
      ...(r.username !== undefined && { username: r.username }),
      ...(r.first_name !== undefined && { firstName: r.first_name }),
    }
  }

  /**
   * Long-poll for updates. The caller is responsible for tracking the next
   * offset (offset = lastUpdateId + 1) and for aborting on shutdown via
   * options.signal.
   */
  async getUpdates(options: TelegramGetUpdatesOptions = {}): Promise<TelegramRawUpdate[]> {
    return this.callApi<TelegramRawUpdate[]>(
      'getUpdates',
      {
        ...(options.offset !== undefined && { offset: options.offset }),
        limit: options.limit ?? 100,
        timeout: options.timeoutSeconds ?? 25,
        ...(options.allowedUpdates !== undefined && { allowed_updates: options.allowedUpdates }),
      },
      options.signal,
    )
  }

  /** Drop any pending updates (useful when starting fresh). */
  async clearPendingUpdates(): Promise<void> {
    const updates = await this.getUpdates({ timeoutSeconds: 0, limit: 1 })
    if (updates.length > 0) {
      const last = updates[updates.length - 1]
      await this.getUpdates({ offset: last.update_id + 1, timeoutSeconds: 0, limit: 1 })
    }
  }

  /**
   * Build a queue-style trigger source that long-polls Telegram and emits
   * one `onMessage(payload)` per inbound text-bearing update. The payload
   * is a flat `TelegramMessageInput` ready to use as a pipeline input.
   *
   * Register the returned object as a triggerSource in `skelm.config.ts`,
   * then have a pipeline declare
   * `triggers: [{ kind: 'queue', sourceId: '<id>' }]`. The gateway wires
   * the rest — runs the workflow per message and (when `postReply` is on)
   * sends `output.reply` back to the chat via `onResult`.
   */
  createTriggerSource(options: CreateTelegramTriggerSourceOptions = {}): TelegramTriggerSource {
    const dropPending = options.dropPending ?? true
    const longPollSeconds = options.longPollSeconds ?? 25
    const allowedUpdates = options.allowedUpdates ?? ['message']
    const postReply = options.postReply ?? true
    const integration = this
    let stopping = false
    let abortCtl: AbortController | null = null
    const seen = new Set<number>()
    let offset: number | undefined
    let loopPromise: Promise<void> | null = null

    const loop = async (onMessage: (payload?: unknown) => Promise<void>): Promise<void> => {
      if (dropPending) {
        try {
          await integration.clearPendingUpdates()
        } catch {
          // best-effort
        }
      }
      while (!stopping) {
        abortCtl = new AbortController()
        let updates: TelegramRawUpdate[]
        try {
          updates = await integration.getUpdates({
            ...(offset !== undefined && { offset }),
            timeoutSeconds: longPollSeconds,
            allowedUpdates,
            signal: abortCtl.signal,
          })
        } catch (err) {
          if (stopping) break
          const msg = err instanceof Error ? err.message : String(err)
          // Telegram returns 409 Conflict for ~30s after a previous
          // long-poll dies; back off harder than for a generic failure.
          const backoff = msg.includes('Conflict') ? 5000 : 1000
          await new Promise((r) => setTimeout(r, backoff))
          continue
        }
        for (const update of updates) {
          if (stopping) break
          offset = update.update_id + 1
          if (seen.has(update.update_id)) continue
          seen.add(update.update_id)
          const input = telegramUpdateToInput(update)
          if (input === null) continue
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
      ...(postReply && {
        async onResult(payload: unknown, output: unknown): Promise<void> {
          const input = payload as TelegramMessageInput | undefined
          const reply = (output as { reply?: unknown } | undefined)?.reply
          if (input === undefined || typeof reply !== 'string' || reply === '') return
          try {
            await integration.sendMessage({
              chatId: input.chatId,
              text: reply,
              replyToMessageId: input.messageId,
            })
          } catch {
            // best-effort; gateway audit will record the run, the loop continues.
          }
        },
      }),
    }
  }

  private async callApi<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.botToken === null) {
      throw new Error('TelegramIntegration not initialized — call init() first')
    }
    const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/${method}`
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal !== undefined && { signal }),
    })
    const json = (await res.json()) as TelegramApiResponse<T>
    if (!json.ok || json.result === undefined) {
      throw new Error(`Telegram API ${method} failed: ${json.description ?? `HTTP ${res.status}`}`)
    }
    return json.result
  }
}
