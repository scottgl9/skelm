import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type CapabilityDescriptor,
  type CredentialReference,
  IdempotencyTracker,
  type LiveTestDescriptor,
  type Page,
  RateLimiter,
  assertNoSecretValue,
  backoffDelay,
  httpRequest,
  isCapabilityDescriptor,
  isCredentialReference,
  normalizeWebhook,
  paginate,
  shouldRunLiveTest,
  verifyHmacSignature,
  withRetry,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// HMAC / signature verification
// ---------------------------------------------------------------------------

describe('verifyHmacSignature', () => {
  const secret = 'shhh'
  const payload = '{"hello":"world"}'

  function sign(prefix = '', encoding: 'hex' | 'base64' = 'hex'): string {
    return `${prefix}${createHmac('sha256', secret).update(payload).digest(encoding)}`
  }

  it('accepts a valid signature', () => {
    expect(verifyHmacSignature({ payload, signature: sign(), secret })).toBe(true)
  })

  it('accepts a valid prefixed signature', () => {
    const signature = sign('sha256=')
    expect(verifyHmacSignature({ payload, signature, secret, prefix: 'sha256=' })).toBe(true)
  })

  it('accepts a valid base64 signature', () => {
    const signature = sign('', 'base64')
    expect(verifyHmacSignature({ payload, signature, secret, encoding: 'base64' })).toBe(true)
  })

  it('rejects a tampered payload', () => {
    const signature = sign()
    expect(verifyHmacSignature({ payload: `${payload} `, signature, secret })).toBe(false)
  })

  it('rejects a tampered signature', () => {
    const signature = `${sign().slice(0, -1)}0`
    expect(verifyHmacSignature({ payload, signature, secret })).toBe(false)
  })

  it('rejects a wrong secret', () => {
    const signature = sign()
    expect(verifyHmacSignature({ payload, signature, secret: 'nope' })).toBe(false)
  })

  it('rejects a length-mismatched signature without throwing', () => {
    expect(verifyHmacSignature({ payload, signature: 'short', secret })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Event-envelope normalization
// ---------------------------------------------------------------------------

describe('normalizeWebhook', () => {
  it('preserves provided id and metadata', () => {
    const env = normalizeWebhook({
      source: 'github',
      type: 'issues.opened',
      id: 'evt-1',
      payload: { number: 7 },
      receivedAt: 123,
      metadata: { delivery: 'abc' },
    })
    expect(env).toEqual({
      source: 'github',
      type: 'issues.opened',
      id: 'evt-1',
      receivedAt: 123,
      payload: { number: 7 },
      metadata: { delivery: 'abc' },
    })
  })

  it('derives a stable id when none supplied', () => {
    const a = normalizeWebhook({ source: 's', type: 't', payload: { x: 1 } })
    const b = normalizeWebhook({ source: 's', type: 't', payload: { x: 1 } })
    expect(a.id).toEqual(b.id)
    const c = normalizeWebhook({ source: 's', type: 't', payload: { x: 2 } })
    expect(c.id).not.toEqual(a.id)
  })

  it('omits metadata when not provided', () => {
    const env = normalizeWebhook({ source: 's', type: 't', payload: 1 })
    expect('metadata' in env).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('IdempotencyTracker', () => {
  it('reports duplicates within the TTL', () => {
    const t = new IdempotencyTracker(1000)
    expect(t.seen('a', 0)).toBe(false)
    expect(t.seen('a', 500)).toBe(true)
  })

  it('forgets entries after the TTL', () => {
    const t = new IdempotencyTracker(1000)
    expect(t.seen('a', 0)).toBe(false)
    expect(t.seen('a', 2000)).toBe(false)
  })

  it('evicts beyond maxEntries', () => {
    const t = new IdempotencyTracker(10_000, 2)
    t.seen('a', 0)
    t.seen('b', 0)
    t.seen('c', 0)
    // 'a' was the oldest and should have been evicted, so it reads as unseen.
    expect(t.seen('a', 1)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Retry / backoff
// ---------------------------------------------------------------------------

describe('backoffDelay', () => {
  it('grows exponentially and caps', () => {
    expect(backoffDelay(0, { baseDelayMs: 100 })).toBe(100)
    expect(backoffDelay(1, { baseDelayMs: 100 })).toBe(200)
    expect(backoffDelay(2, { baseDelayMs: 100 })).toBe(400)
    expect(backoffDelay(20, { baseDelayMs: 100, maxDelayMs: 1000 })).toBe(1000)
  })

  it('applies bounded jitter', () => {
    const lo = backoffDelay(2, { baseDelayMs: 100, jitter: 0.5, random: () => 0 })
    const hi = backoffDelay(2, { baseDelayMs: 100, jitter: 0.5, random: () => 1 })
    expect(lo).toBe(200)
    expect(hi).toBe(400)
  })
})

describe('withRetry', () => {
  it('returns on first success', async () => {
    let calls = 0
    const r = await withRetry(async () => {
      calls++
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries up to maxAttempts then rethrows', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('boom')
        },
        { maxAttempts: 3, sleep: async () => {} },
      ),
    ).rejects.toThrow('boom')
    expect(calls).toBe(3)
  })

  it('does not retry non-retryable errors', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('fatal')
        },
        { maxAttempts: 5, isRetryable: () => false, sleep: async () => {} },
      ),
    ).rejects.toThrow('fatal')
    expect(calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  it('allows up to the limit then blocks', () => {
    const rl = new RateLimiter(2, 1000)
    expect(rl.tryAcquire(0)).toBe(true)
    expect(rl.tryAcquire(0)).toBe(true)
    expect(rl.tryAcquire(0)).toBe(false)
  })

  it('frees a slot after the window', () => {
    const rl = new RateLimiter(1, 1000)
    expect(rl.tryAcquire(0)).toBe(true)
    expect(rl.tryAcquire(500)).toBe(false)
    expect(rl.waitTimeMs(500)).toBe(500)
    expect(rl.tryAcquire(1000)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('paginate', () => {
  it('walks cursors to exhaustion', async () => {
    const pages: Record<string, Page<number>> = {
      __start: { items: [1, 2], nextCursor: 'p2' },
      p2: { items: [3], nextCursor: 'p3' },
      p3: { items: [4] },
    }
    const out: number[] = []
    for await (const n of paginate<number>((c) =>
      Promise.resolve(pages[c ?? '__start'] as Page<number>),
    )) {
      out.push(n)
    }
    expect(out).toEqual([1, 2, 3, 4])
  })

  it('stops at maxPages', async () => {
    const out: number[] = []
    for await (const n of paginate<number>(
      () => Promise.resolve({ items: [1], nextCursor: 'next' }),
      { maxPages: 2 },
    )) {
      out.push(n)
    }
    expect(out).toEqual([1, 1])
  })
})

// ---------------------------------------------------------------------------
// HTTP egress gating
// ---------------------------------------------------------------------------

describe('httpRequest', () => {
  it('refuses when egress policy denies the host', async () => {
    await expect(
      httpRequest('https://evil.example/x', {
        egress: () => ({ allow: false, reason: 'not allowlisted' }),
      }),
    ).rejects.toThrow(/Egress denied for host "evil.example": not allowlisted/)
  })

  it('rejects a malformed URL', async () => {
    await expect(httpRequest('not a url', { egress: () => ({ allow: true }) })).rejects.toThrow(
      /Invalid URL/,
    )
  })

  it('passes through when allowed', async () => {
    let calledUrl = ''
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url)
      return new Response('ok')
    }) as unknown as typeof fetch
    const res = await httpRequest('https://api.example/v1', {
      egress: (host) => ({ allow: host === 'api.example' }),
      fetchImpl: fakeFetch,
    })
    expect(calledUrl).toBe('https://api.example/v1')
    expect(await res.text()).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Capability descriptor + credential ref type guards
// ---------------------------------------------------------------------------

describe('isCapabilityDescriptor', () => {
  it('accepts a complete descriptor', () => {
    const d: CapabilityDescriptor = {
      provider: 'slack',
      editMessage: true,
      deleteMessage: false,
      replyInThread: true,
      reactions: true,
      buttons: true,
      slashCommands: true,
      media: ['image', 'file'],
      mediaSources: ['url'],
    }
    expect(isCapabilityDescriptor(d)).toBe(true)
  })

  it('rejects an incomplete descriptor', () => {
    expect(isCapabilityDescriptor({ provider: 'x' })).toBe(false)
    expect(isCapabilityDescriptor(null)).toBe(false)
  })
})

describe('isCredentialReference', () => {
  it('accepts a valid reference', () => {
    const ref: CredentialReference = { kind: 'credential-ref', secretName: 'SLACK_TOKEN' }
    expect(isCredentialReference(ref)).toBe(true)
  })

  it('rejects non-references', () => {
    expect(isCredentialReference({ secretName: 'x' })).toBe(false)
    expect(isCredentialReference({ kind: 'credential-ref' })).toBe(false)
    expect(isCredentialReference(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Credential-reference-only invariant
// ---------------------------------------------------------------------------

describe('credential reference cannot carry a value', () => {
  it('compile-time: a value-bearing object is not assignable to CredentialReference', () => {
    // @ts-expect-error — `value` is not part of CredentialReference; a resolved
    // secret value cannot be smuggled through the reference type.
    const bad: CredentialReference = { kind: 'credential-ref', secretName: 'X', value: 'leaked' }
    void bad
  })

  it('runtime: assertNoSecretValue throws when a value-bearing field is present', () => {
    expect(() =>
      assertNoSecretValue({ kind: 'credential-ref', secretName: 'X', value: 'leaked' }),
    ).toThrow(/must not carry a secret value/)
    expect(() =>
      assertNoSecretValue({ kind: 'credential-ref', secretName: 'X', token: 'abc' }),
    ).toThrow(/offending field: "token"/)
  })

  it('runtime: assertNoSecretValue accepts a clean reference', () => {
    expect(() => assertNoSecretValue({ kind: 'credential-ref', secretName: 'X' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Live-test gating
// ---------------------------------------------------------------------------

describe('shouldRunLiveTest', () => {
  const descriptor: LiveTestDescriptor = {
    provider: 'slack',
    name: 'live slack roundtrip',
    requiredEnv: ['SKELM_LIVE_SLACK', 'SKELM_SLACK_BOT_TOKEN'],
  }

  it('runs only when every required env var is set', () => {
    expect(
      shouldRunLiveTest(descriptor, { SKELM_LIVE_SLACK: '1', SKELM_SLACK_BOT_TOKEN: 'xoxb-x' }),
    ).toBe(true)
  })

  it('skips when any env var is missing or empty', () => {
    expect(shouldRunLiveTest(descriptor, { SKELM_LIVE_SLACK: '1' })).toBe(false)
    expect(
      shouldRunLiveTest(descriptor, { SKELM_LIVE_SLACK: '', SKELM_SLACK_BOT_TOKEN: 'x' }),
    ).toBe(false)
  })
})
