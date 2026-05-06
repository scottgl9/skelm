import { IntegrationBase } from './base.js'
import type { TelegramConfig, TelegramMessageTrigger, TelegramWebhookEvent } from './types.js'

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
