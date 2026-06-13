import { describe, expect, it, vi } from 'vitest'
import { VaultSecretError, VaultSecretResolver } from '../../src/secrets/vault-driver.js'

const TOKEN = 's.supersecrettoken'
const VALUE = 'sk-the-actual-secret-value'

function kvV2Response(value: string, status = 200): Response {
  return new Response(JSON.stringify({ data: { data: { value } } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function resolver(fetchStub: typeof fetch, opts = {}): VaultSecretResolver {
  return new VaultSecretResolver({
    url: 'https://vault.test:8200',
    token: TOKEN,
    fetch: fetchStub,
    ...opts,
  })
}

describe('VaultSecretResolver — KV v2 over HTTP', () => {
  it('returns the value on a hit and sends the token in the header', async () => {
    const fetchStub = vi.fn(async () => kvV2Response(VALUE)) as unknown as typeof fetch
    const r = resolver(fetchStub)
    expect(await r.resolve('OPENAI_KEY')).toBe(VALUE)
    const [url, init] = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://vault.test:8200/v1/secret/data/OPENAI_KEY')
    expect((init as RequestInit).headers).toMatchObject({ 'X-Vault-Token': TOKEN })
  })

  it('preserves nested secret paths when applying mount and prefix', async () => {
    const fetchStub = vi.fn(async () => kvV2Response(VALUE)) as unknown as typeof fetch
    const r = resolver(fetchStub, { mount: 'kv', prefix: 'skelm/' })
    await r.resolve('nested/OPENAI_KEY')
    const [url] = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://vault.test:8200/v1/kv/data/skelm/nested/OPENAI_KEY')
  })

  it('rejects parent-segment traversal before issuing the request', async () => {
    const fetchStub = vi.fn(async () => kvV2Response(VALUE)) as unknown as typeof fetch
    const r = resolver(fetchStub, { mount: 'kv', prefix: 'skelm/' })
    const err = (await r.resolve('../foo').catch((e) => e)) as VaultSecretError
    expect(err).toBeInstanceOf(VaultSecretError)
    expect(err.message).toContain('must not contain dot segments')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('rejects current-directory segments before issuing the request', async () => {
    const fetchStub = vi.fn(async () => kvV2Response(VALUE)) as unknown as typeof fetch
    const r = resolver(fetchStub, { mount: 'kv', prefix: 'skelm/' })
    const err = (await r.resolve('./foo').catch((e) => e)) as VaultSecretError
    expect(err).toBeInstanceOf(VaultSecretError)
    expect(err.message).toContain('must not contain dot segments')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('returns undefined on 404 (unknown secret)', async () => {
    const fetchStub = vi.fn(
      async () => new Response('', { status: 404 }),
    ) as unknown as typeof fetch
    const r = resolver(fetchStub)
    expect(await r.resolve('NOPE')).toBeUndefined()
  })

  it('throws a typed error on auth failure (403)', async () => {
    const fetchStub = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch
    const r = resolver(fetchStub)
    await expect(r.resolve('OPENAI_KEY')).rejects.toBeInstanceOf(VaultSecretError)
  })

  it('throws a typed error on transport failure', async () => {
    const fetchStub = vi.fn(async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    const r = resolver(fetchStub)
    await expect(r.resolve('OPENAI_KEY')).rejects.toBeInstanceOf(VaultSecretError)
  })

  it('NEVER includes the secret value or the token in the error message', async () => {
    // 200 OK but missing the expected field — driver must error WITHOUT
    // echoing a value, and the token must never appear in any error.
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      // sanity: the token IS sent on the wire
      expect((init.headers as Record<string, string>)['X-Vault-Token']).toBe(TOKEN)
      return new Response(JSON.stringify({ data: { data: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const r = resolver(fetchStub)
    const err = await r.resolve('OPENAI_KEY').catch((e) => e)
    expect(err).toBeInstanceOf(VaultSecretError)
    expect(err.message).not.toContain(VALUE)
    expect(err.message).not.toContain(TOKEN)
  })

  it('auth-failure error message excludes token and value', async () => {
    const fetchStub = vi.fn(async () => kvV2Response(VALUE, 401)) as unknown as typeof fetch
    const r = resolver(fetchStub)
    const err = (await r.resolve('OPENAI_KEY').catch((e) => e)) as VaultSecretError
    expect(err.message).not.toContain(TOKEN)
    expect(err.message).not.toContain(VALUE)
    expect(err.message).toContain('OPENAI_KEY')
    expect(err.status).toBe(401)
  })

  it('never writes the value or token to console', async () => {
    const logs: string[] = []
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' '))),
      vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.join(' '))),
      vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' '))),
    ]
    try {
      const okFetch = vi.fn(async () => kvV2Response(VALUE)) as unknown as typeof fetch
      await resolver(okFetch).resolve('OPENAI_KEY')
      const failFetch = vi.fn(
        async () => new Response('', { status: 500 }),
      ) as unknown as typeof fetch
      await resolver(failFetch)
        .resolve('OPENAI_KEY')
        .catch(() => {})
    } finally {
      for (const s of spies) s.mockRestore()
    }
    const joined = logs.join('\n')
    expect(joined).not.toContain(VALUE)
    expect(joined).not.toContain(TOKEN)
  })

  it('serves a cached value within the TTL without a second fetch', async () => {
    const fetchStub = vi.fn(async () => kvV2Response(VALUE)) as unknown as typeof fetch
    const r = resolver(fetchStub, { cacheTtlMs: 60_000 })
    expect(await r.resolve('OPENAI_KEY')).toBe(VALUE)
    expect(await r.resolve('OPENAI_KEY')).toBe(VALUE)
    expect((fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
})
