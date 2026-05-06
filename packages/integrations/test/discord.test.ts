import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscordIntegration } from '../src/discord.js'
import type { DiscordConfig, DiscordWebhookEvent } from '../src/types.js'

const baseConfig: DiscordConfig = {
  id: 'discord',
  name: 'Discord',
  enabled: true,
  credentials: {
    botToken: 'bot-token-redacted',
    applicationId: 'app-id',
    publicKey: 'pub-key-hex',
    channelId: 'channel-id',
  },
}

describe('DiscordIntegration', () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('rejects credentials missing the bot token', async () => {
    const integration = new DiscordIntegration({
      ...baseConfig,
      credentials: { botToken: '' as string },
    })
    await expect(integration.init()).rejects.toThrow(/botToken required/)
  })

  it('treats type=1 (PING) as a verification event', async () => {
    const integration = new DiscordIntegration(baseConfig)
    await integration.init()
    const result = await integration.eventToRunInput({ type: 1 } as DiscordWebhookEvent)
    expect(result).toEqual({ type: 'discord-ping' })
  })

  it('projects a slash command (type=2) into a typed trigger', async () => {
    const integration = new DiscordIntegration(baseConfig)
    await integration.init()
    const event: DiscordWebhookEvent = {
      type: 2,
      channel_id: 'C',
      user: { id: 'U', username: 'alice' },
      data: { name: 'review', options: [{ name: 'pr', value: '42' }] },
      token: 't',
    }
    const result = await integration.eventToRunInput(event)
    expect(result).toEqual(
      expect.objectContaining({
        trigger: expect.objectContaining({
          type: 'discord-slash-command',
          channel: 'C',
          user: 'U',
          name: 'review',
        }),
      }),
    )
  })

  it('projects a message component (type=3) interaction', async () => {
    const integration = new DiscordIntegration(baseConfig)
    await integration.init()
    const event: DiscordWebhookEvent = {
      type: 3,
      channel_id: 'C',
      user: { id: 'U' },
      data: { custom_id: 'btn-approve' },
    }
    const result = await integration.eventToRunInput(event)
    expect(result).toEqual(
      expect.objectContaining({
        trigger: expect.objectContaining({
          type: 'discord-component',
          customId: 'btn-approve',
        }),
      }),
    )
  })

  it('returns null for unhandled interaction types', async () => {
    const integration = new DiscordIntegration(baseConfig)
    await integration.init()
    const result = await integration.eventToRunInput({ type: 999 } as DiscordWebhookEvent)
    expect(result).toBeNull()
  })

  it('sendNotification posts to the channel and returns the message id', async () => {
    const integration = new DiscordIntegration(baseConfig)
    await integration.init()
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      expect(u).toContain('/channels/channel-id/messages')
      const body = JSON.parse((init?.body as string) ?? '{}') as { content?: string }
      expect(body.content).toBe('hello')
      expect((init?.headers as Record<string, string>)?.Authorization).toMatch(/^Bot /)
      return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await integration.sendNotification('hello')
    expect(result).toEqual({ id: 'msg-1' })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('sendNotification throws on a non-2xx response', async () => {
    const integration = new DiscordIntegration(baseConfig)
    await integration.init()
    globalThis.fetch = (async () =>
      new Response('nope', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch
    await expect(integration.sendNotification('hi')).rejects.toThrow(/401/)
  })

  it('react encodes the emoji into the URL', async () => {
    const integration = new DiscordIntegration(baseConfig)
    await integration.init()
    const fetchSpy = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/reactions/%F0%9F%91%8D/@me')
      return new Response(null, { status: 200 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    await integration.react('C', 'M', '👍')
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('verifySignature returns false for malformed inputs', async () => {
    const integration = new DiscordIntegration(baseConfig)
    await integration.init()
    const result = await integration.verifySignature({
      publicKey: '',
      timestamp: '1',
      rawBody: '{}',
      signature: 'deadbeef',
    })
    expect(result).toBe(false)
  })

  it('toMessageTrigger produces a typed trigger from a slash command', async () => {
    const integration = new DiscordIntegration(baseConfig)
    await integration.init()
    const event: DiscordWebhookEvent = {
      type: 2,
      channel_id: 'C',
      user: { id: 'U', username: 'alice' },
      data: { name: 'echo', options: [{ name: 'text', value: 'hi' }] },
    }
    const trig = integration.toMessageTrigger(event)
    expect(trig).toEqual(
      expect.objectContaining({
        channelId: 'C',
        userId: 'U',
        username: 'alice',
        content: 'hi',
      }),
    )
  })
})
