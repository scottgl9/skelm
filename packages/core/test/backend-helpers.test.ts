import { describe, expect, it } from 'vitest'
import {
  type AgentRequest,
  type BackendContext,
  PermissionDeniedError,
  type ResolvedPolicy,
  type Skill,
  assertEgressEnforceable,
  combineSignals,
  createConcurrencySemaphore,
  loadSkillBodies,
  timeoutSignal,
} from '../src/index.js'

describe('createConcurrencySemaphore', () => {
  it('lets work in below the cap proceed immediately', async () => {
    const sem = createConcurrencySemaphore(2)
    await sem.acquire()
    await sem.acquire()
    sem.release()
    sem.release()
  })

  it('queues callers above the cap and releases in FIFO order', async () => {
    const sem = createConcurrencySemaphore(1)
    await sem.acquire()
    const order: number[] = []
    const second = sem.acquire().then(() => order.push(2))
    const third = sem.acquire().then(() => order.push(3))
    sem.release()
    await second
    sem.release()
    await third
    expect(order).toEqual([2, 3])
  })

  it('cap of 0 disables throttling', async () => {
    const sem = createConcurrencySemaphore(0)
    await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()])
  })
})

describe('loadSkillBodies', () => {
  const baseReq: AgentRequest = { prompt: 'hi' } as AgentRequest

  function fakeCtx(loader: (id: string) => Promise<Skill | null>): BackendContext {
    return {
      signal: new AbortController().signal,
      loadSkill: loader,
    } as unknown as BackendContext
  }

  it('returns [] when there are no skills', async () => {
    const ctx = fakeCtx(async () => null)
    expect(await loadSkillBodies(baseReq, ctx)).toEqual([])
  })

  it('returns [] when ctx.loadSkill is missing', async () => {
    const req = { ...baseReq, skills: ['x'] }
    const ctx = { signal: new AbortController().signal } as unknown as BackendContext
    expect(await loadSkillBodies(req, ctx)).toEqual([])
  })

  it('skips skills that resolve to null', async () => {
    const req = { ...baseReq, skills: ['a', 'b'] }
    const ctx = fakeCtx(async (id) =>
      id === 'a'
        ? ({
            id: 'a',
            name: 'A',
            description: 'A',
            body: 'body-a',
            metadata: {},
          } as unknown as Skill)
        : null,
    )
    const bodies = await loadSkillBodies(req, ctx)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('body-a')
  })
})

describe('assertEgressEnforceable', () => {
  it('no-op on undefined policy', () => {
    assertEgressEnforceable(undefined, 'test')
  })

  it('passes when networkEgress is "allow"', () => {
    const policy = { networkEgress: 'allow' } as unknown as ResolvedPolicy
    assertEgressEnforceable(policy, 'test')
  })

  it('throws PermissionDeniedError when networkEgress is "deny"', () => {
    const policy = { networkEgress: 'deny' } as unknown as ResolvedPolicy
    expect(() => assertEgressEnforceable(policy, 'test')).toThrow(PermissionDeniedError)
  })

  it('throws when networkEgress is a host allowlist', () => {
    const policy = { networkEgress: { allowHosts: ['x'] } } as unknown as ResolvedPolicy
    expect(() => assertEgressEnforceable(policy, 'test')).toThrow(PermissionDeniedError)
  })
})

describe('combineSignals + timeoutSignal', () => {
  it('combined signal aborts when any input aborts', () => {
    const a = new AbortController()
    const b = new AbortController()
    const s = combineSignals(a.signal, b.signal)
    expect(s.aborted).toBe(false)
    b.abort(new Error('b'))
    expect(s.aborted).toBe(true)
  })

  it('treats undefined inputs as absent', () => {
    const a = new AbortController()
    const s = combineSignals(undefined, a.signal, undefined)
    a.abort()
    expect(s.aborted).toBe(true)
  })

  it('timeoutSignal fires after ms and is clearable', async () => {
    const { signal, clear } = timeoutSignal(20)
    await new Promise((r) => setTimeout(r, 35))
    expect(signal.aborted).toBe(true)
    clear()
  })
})
