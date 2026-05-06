import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramIntegration } from '../src/telegram.js'
import type { TelegramConfig } from '../src/types.js'

const validToken = '123456:AAEPSM2FNFp4ux-rWo9d97UNybRhJ4TffBU'

function makeConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    id: 'telegram',
    name: 'Telegram',
    enabled: true,
    credentials: { botToken: validToken, ...(overrides.credentials ?? {}) },
    ...(overrides.webhook !== undefined && { webhook: overrides.webhook }),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('TelegramIntegration', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects missing bot token', async () => {
    const cfg = makeConfig()
    cfg.credentials.botToken = ''
    const tg = new TelegramIntegration(cfg, { fetch: fetchMock as unknown as typeof fetch })
    await expect(tg.init()).rejects.toThrow(/botToken required/)
  })

  it('rejects malformed bot token', async () => {
    const cfg = makeConfig({ credentials: { botToken: 'not-a-token' } })
    const tg = new TelegramIntegration(cfg, { fetch: fetchMock as unknown as typeof fetch })
    await expect(tg.init()).rejects.toThrow(/Invalid Telegram bot token format/)
  })

  it('initializes with valid token', async () => {
    const tg = new TelegramIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await expect(tg.init()).resolves.toBeUndefined()
  })

  it('sendMessage POSTs to the bot API and returns messageId', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, result: { message_id: 42, chat: { id: 1 }, date: 0 } }),
    )
    const tg = new TelegramIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await tg.init()
    const out = await tg.sendMessage({ chatId: 1, text: 'hi', parseMode: 'Markdown' })
    expect(out.messageId).toBe(42)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`https://api.telegram.org/bot${validToken}/sendMessage`)
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({ chat_id: 1, text: 'hi', parse_mode: 'Markdown' })
  })

  it('sendNotification falls back to credentials.chatId', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, result: { message_id: 1, chat: { id: 99 }, date: 0 } }),
    )
    const tg = new TelegramIntegration(
      makeConfig({ credentials: { botToken: validToken, chatId: '99' } }),
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await tg.init()
    await tg.sendNotification('hello')
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.chat_id).toBe('99')
    expect(body.text).toBe('hello')
  })

  it('sendNotification throws when no chatId is configured or supplied', async () => {
    const tg = new TelegramIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await tg.init()
    await expect(tg.sendNotification('hi')).rejects.toThrow(/chatId/)
  })

  it('throws when API returns ok:false', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, description: 'Unauthorized', error_code: 401 }, 401),
    )
    const tg = new TelegramIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await tg.init()
    await expect(tg.sendMessage({ chatId: 1, text: 'x' })).rejects.toThrow(/Unauthorized/)
  })

  it('eventToRunInput maps a message update to a TelegramMessageTrigger', async () => {
    const tg = new TelegramIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await tg.init()
    const update = {
      update_id: 7,
      message: {
        message_id: 100,
        chat: { id: 12345 },
        from: { id: 1, username: 'alice' },
        date: 1700000000,
        text: 'hello bot',
      },
    }
    const out = await tg.eventToRunInput(update)
    expect(out).toEqual({
      trigger: {
        type: 'telegram-message',
        messageId: 100,
        chatId: '12345',
        from: 'alice',
        text: 'hello bot',
        date: 1700000000,
        updateId: 7,
      },
    })
  })

  it('eventToRunInput returns null for non-message updates', async () => {
    const tg = new TelegramIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await tg.init()
    expect(await tg.eventToRunInput({ update_id: 1 })).toBeNull()
  })

  it('verifyWebhookSecret matches only on exact equality', async () => {
    const tg = new TelegramIntegration(
      makeConfig({ webhook: { path: '/wh', secret: 'shh', events: [] } }),
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await tg.init()
    expect(tg.verifyWebhookSecret('shh')).toBe(true)
    expect(tg.verifyWebhookSecret('SHH')).toBe(false)
    expect(tg.verifyWebhookSecret(undefined)).toBe(false)
    expect(tg.verifyWebhookSecret('')).toBe(false)
  })

  it('verifyWebhookSecret returns false when no secret is configured', async () => {
    const tg = new TelegramIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await tg.init()
    expect(tg.verifyWebhookSecret('anything')).toBe(false)
  })

  it('getUpdates passes offset and timeout to the API', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: [] }))
    const tg = new TelegramIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await tg.init()
    await tg.getUpdates({ offset: 5, timeoutSeconds: 1, limit: 10 })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({ offset: 5, timeout: 1, limit: 10 })
  })
})
