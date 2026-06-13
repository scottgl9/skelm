import {
  type Connection,
  type CredentialReference,
  assertNoSecretValue,
} from '@skelm/integration-sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  DISCORD_CAPABILITIES,
  DISCORD_CREDENTIAL_SCHEMA,
  DISCORD_MOCK_FIXTURE,
  DiscordAdapter,
  DiscordApiError,
  type DiscordGatewayDispatch,
  discordHealthCheck,
  discordManifest,
  isRetryableDiscordError,
  normalizeGatewayDispatch,
} from '../src/index.js'

const allowDiscord = (host: string) => ({ allow: host === 'discord.com' })

const tokenRef: CredentialReference = { kind: 'credential-ref', secretName: 'DISCORD_BOT_TOKEN' }

const connection: Connection = {
  id: 'conn-1',
  integrationId: 'discord',
  credentialSchemaId: 'discord',
  credentials: [tokenRef],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeAdapter(fetchImpl: typeof fetch, resolved = 'resolved-token') {
  return new DiscordAdapter({
    egress: allowDiscord,
    tokenResolver: async () => resolved,
    fetchImpl,
  })
}

describe('credential-ref shape', () => {
  it('declares the bot token as a token-kind field with no value', () => {
    const field = DISCORD_CREDENTIAL_SCHEMA.fields.find((f) => f.name === 'botToken')
    expect(field?.kind).toBe('token')
  })

  it('the connection carries references only — no smuggled value', () => {
    for (const ref of connection.credentials) {
      expect(() => assertNoSecretValue(ref)).not.toThrow()
      expect(ref).not.toHaveProperty('value')
      expect(ref).not.toHaveProperty('token')
    }
  })
})

describe('DiscordAdapter capability descriptor', () => {
  it('advertises edit/delete/threads/reactions/buttons without slash-command registration or outbound media', () => {
    expect(DISCORD_CAPABILITIES.editMessage).toBe(true)
    expect(DISCORD_CAPABILITIES.deleteMessage).toBe(true)
    expect(DISCORD_CAPABILITIES.replyInThread).toBe(true)
    expect(DISCORD_CAPABILITIES.reactions).toBe(true)
    expect(DISCORD_CAPABILITIES.buttons).toBe(true)
    expect(DISCORD_CAPABILITIES.slashCommands).toBe(false)
    expect(DISCORD_CAPABILITIES.media).toEqual([])
    expect(DISCORD_CAPABILITIES.maxMessageLength).toBe(2000)
  })

  it('does not expose registerCommands while slash-command registration is unsupported', () => {
    const adapter = makeAdapter(vi.fn() as unknown as typeof fetch)
    expect('registerCommands' in adapter).toBe(false)
  })
})

describe('DiscordAdapter send/edit/delete/react over a fake transport', () => {
  it('sends a message and returns the provider message ref', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 'm1', channel_id: '2222222222222222222' }),
    ) as unknown as typeof fetch
    const adapter = makeAdapter(fetchImpl)
    await adapter.connect(connection)
    const ref = await adapter.sendMessage({
      target: { conversationId: '2222222222222222222' },
      text: 'hi',
    })
    expect(ref.messageId).toBe('m1')
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/channels/2222222222222222222/messages')
    expect((init as RequestInit).method).toBe('POST')
    expect(((init as RequestInit).headers as Record<string, string>).authorization).toBe(
      'Bot resolved-token',
    )
  })

  it('edits a message via PATCH', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 'm1', channel_id: 'c1' }),
    ) as unknown as typeof fetch
    const adapter = makeAdapter(fetchImpl)
    await adapter.connect(connection)
    await adapter.editMessage(
      { messageId: 'm1', target: { conversationId: 'c1' } },
      { target: { conversationId: 'c1' }, text: 'edited' },
    )
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((init as RequestInit).method).toBe('PATCH')
  })

  it('deletes a message via DELETE returning 204', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch
    const adapter = makeAdapter(fetchImpl)
    await adapter.connect(connection)
    await expect(
      adapter.deleteMessage({ messageId: 'm1', target: { conversationId: 'c1' } }),
    ).resolves.toBeUndefined()
  })

  it('adds a reaction via the url-encoded reactions endpoint', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch
    const adapter = makeAdapter(fetchImpl)
    await adapter.connect(connection)
    await adapter.addReaction({ messageId: 'm1', target: { conversationId: 'c1' } }, '👍')
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/reactions/')
    expect(url).toContain('/@me')
  })

  it('throws when used before connect', async () => {
    const adapter = makeAdapter(vi.fn() as unknown as typeof fetch)
    await expect(
      adapter.sendMessage({ target: { conversationId: 'c1' }, text: 'x' }),
    ).rejects.toThrow(/not connected/)
  })

  it('rejects outbound attachments instead of emitting unsupported Discord metadata', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const adapter = makeAdapter(fetchImpl)
    await adapter.connect(connection)
    await expect(
      adapter.sendMessage({
        target: { conversationId: 'c1' },
        attachments: [{ kind: 'image', contentType: 'image/png', filename: 'x.png', data: 'AA==' }],
      }),
    ).rejects.toThrow(/outbound media upload is not supported/)
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('refuses a denied egress host', async () => {
    const denyAll = () => ({ allow: false, reason: 'blocked' })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const adapter = new DiscordAdapter({
      egress: denyAll,
      tokenResolver: async () => 't',
      fetchImpl,
    })
    await adapter.connect(connection)
    await expect(
      adapter.sendMessage({ target: { conversationId: 'c1' }, text: 'x' }),
    ).rejects.toThrow(/Egress denied/)
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })
})

describe('inbound subscription drives normalized events', () => {
  it('emits normalized fixtures to subscribers and unsubscribes', async () => {
    const adapter = makeAdapter(vi.fn() as unknown as typeof fetch)
    const received: string[] = []
    const unsub = adapter.onInbound((e) => received.push(e.type))
    const event = normalizeGatewayDispatch(
      DISCORD_MOCK_FIXTURE.payloads.messageCreate as DiscordGatewayDispatch,
    )
    if (event) adapter.emitInbound(event)
    unsub()
    if (event) adapter.emitInbound(event)
    expect(received).toEqual(['message'])
  })
})

describe('rate-limit / retry classification', () => {
  it('classifies 429 and 5xx as retryable, other 4xx as not', () => {
    expect(isRetryableDiscordError(new DiscordApiError('rate', 429))).toBe(true)
    expect(isRetryableDiscordError(new DiscordApiError('server', 503))).toBe(true)
    expect(isRetryableDiscordError(new DiscordApiError('bad', 400))).toBe(false)
    expect(isRetryableDiscordError(new DiscordApiError('forbidden', 403))).toBe(false)
    // Transport errors (no status) are retryable.
    expect(isRetryableDiscordError(new Error('ECONNRESET'))).toBe(true)
  })

  it('retries a 429 then succeeds', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) return jsonResponse({ message: 'rate limited', code: 0 }, 429)
      return jsonResponse({ id: 'm1', channel_id: 'c1' })
    }) as unknown as typeof fetch
    const adapter = makeAdapter(fetchImpl)
    await adapter.connect(connection)
    const ref = await adapter.sendMessage({ target: { conversationId: 'c1' }, text: 'x' })
    expect(ref.messageId).toBe('m1')
    expect(calls).toBe(2)
  })
})

describe('discordHealthCheck', () => {
  it('reports healthy on a successful /users/@me', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'bot' })) as unknown as typeof fetch
    const result = await discordHealthCheck({
      connection,
      egress: allowDiscord,
      tokenResolver: async () => 't',
      fetchImpl,
    })
    expect(result.healthy).toBe(true)
    expect(result.status).toBe('ok')
  })

  it('reports error on failure without leaking the token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: 'Unauthorized', code: 0 }, 401),
    ) as unknown as typeof fetch
    const result = await discordHealthCheck({
      connection,
      egress: allowDiscord,
      tokenResolver: async () => 'super-secret-token',
      fetchImpl,
    })
    expect(result.healthy).toBe(false)
    expect(result.status).toBe('error')
    expect(result.detail ?? '').not.toContain('super-secret-token')
  })
})

describe('secret redaction', () => {
  it('the manifest never embeds a token value and redacts the token path', () => {
    const serialized = JSON.stringify(discordManifest)
    expect(serialized).not.toMatch(/Bot [A-Za-z0-9._-]{20,}/)
    expect(discordManifest.auditRedaction?.redactPaths).toContain('headers.authorization')
    expect(discordManifest.auditRedaction?.redactPaths).toContain('credentials.botToken')
  })

  it('error messages from a failed call do not contain the token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: 'Missing Permissions', code: 50013 }, 403),
    ) as unknown as typeof fetch
    const adapter = makeAdapter(fetchImpl, 'tok-DO-NOT-LEAK')
    await adapter.connect(connection)
    await expect(
      adapter.sendMessage({ target: { conversationId: 'c1' }, text: 'x' }),
    ).rejects.toThrow(/Missing Permissions/)
    await adapter
      .sendMessage({ target: { conversationId: 'c1' }, text: 'x' })
      .catch((e: unknown) => {
        expect(String(e)).not.toContain('tok-DO-NOT-LEAK')
      })
  })
})
