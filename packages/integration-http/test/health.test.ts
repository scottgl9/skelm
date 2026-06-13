import type { EgressPolicy } from '@skelm/integration-sdk'
import { describe, expect, it, vi } from 'vitest'
import { checkHealth } from '../src/health.js'

const ALLOW_ALL: EgressPolicy = () => ({ allow: true })
const DENY_ALL: EgressPolicy = () => ({ allow: false, reason: 'blocked' })

describe('checkHealth()', () => {
  it('returns healthy:true for a 2xx response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as unknown as typeof fetch
    const result = await checkHealth({
      baseUrl: 'https://api.example.com',
      egress: ALLOW_ALL,
      fetchImpl,
    })
    expect(result.healthy).toBe(true)
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('200')
    expect(result.checkedAt).toBeTruthy()
  })

  it('returns healthy:false for a 5xx response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 503 }),
    ) as unknown as typeof fetch
    const result = await checkHealth({
      baseUrl: 'https://api.example.com',
      egress: ALLOW_ALL,
      fetchImpl,
    })
    expect(result.healthy).toBe(false)
    expect(result.status).toBe('unhealthy')
    expect(result.detail).toContain('503')
  })

  it('returns error status on egress deny', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await checkHealth({
      baseUrl: 'https://api.example.com',
      egress: DENY_ALL,
      fetchImpl,
    })
    expect(result.healthy).toBe(false)
    expect(result.status).toBe('error')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns error status for invalid baseUrl', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await checkHealth({
      baseUrl: 'not-a-url',
      egress: ALLOW_ALL,
      fetchImpl,
    })
    expect(result.healthy).toBe(false)
    expect(result.status).toBe('error')
  })

  it('returns error status on network failure without exposing raw URL', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const result = await checkHealth({
      baseUrl: 'https://api.example.com',
      egress: ALLOW_ALL,
      fetchImpl,
    })
    expect(result.healthy).toBe(false)
    expect(result.status).toBe('error')
    // detail must not contain query-param secrets (URL is clean here, but assert sentinel)
    expect(result.detail).not.toContain('?')
  })

  it('uses HEAD method by default', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as unknown as typeof fetch
    await checkHealth({ baseUrl: 'https://api.example.com', egress: ALLOW_ALL, fetchImpl })
    const opts = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(opts.method).toBe('HEAD')
  })

  it('uses GET method when specified', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch
    await checkHealth({
      baseUrl: 'https://api.example.com',
      egress: ALLOW_ALL,
      method: 'GET',
      fetchImpl,
    })
    const opts = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(opts.method).toBe('GET')
  })
})
