import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpSessionManager, defaultAcpSessionStorePath } from '../src/index.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skelm-acp-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('AcpSessionManager', () => {
  it('creates / lists / gets / terminates and persists across instances', async () => {
    const path = defaultAcpSessionStorePath(dir)
    const a = new AcpSessionManager({ storePath: path })
    const s = await a.create({ agentId: 'opencode-1' })
    expect(s.state).toBe('active')

    const b = new AcpSessionManager({ storePath: path })
    await b.reconcile()
    expect(b.list().map((x) => x.id)).toEqual([s.id])
    expect(b.get(s.id)?.agentId).toBe('opencode-1')

    expect(await b.terminate(s.id)).toBe(true)
    expect(await b.terminate(s.id)).toBe(false)
  })

  it('marks sessions older than expireAfterMs as expired and refuses resume', async () => {
    const path = defaultAcpSessionStorePath(dir)
    const a = new AcpSessionManager({ storePath: path })
    const s = await a.create({ agentId: 'agent' })

    // Manually backdate via touch + filesystem rewrite would be simpler;
    // here we rebuild a manager with a 0ms expire window to force expiry.
    const b = new AcpSessionManager({ storePath: path, expireAfterMs: 0 })
    await new Promise((r) => setTimeout(r, 5))
    await b.reconcile()
    expect(b.get(s.id)?.state).toBe('expired')
    expect(await b.resume(s.id)).toBeUndefined()
  })

  it('touch + resume update lastSeenAt and state', async () => {
    const a = new AcpSessionManager({ storePath: defaultAcpSessionStorePath(dir) })
    const s = await a.create({ agentId: 'x' })
    const t1 = s.lastSeenAt
    await new Promise((r) => setTimeout(r, 5))
    const touched = await a.touch(s.id)
    expect(touched?.lastSeenAt).not.toBe(t1)
    const resumed = await a.resume(s.id)
    expect(resumed?.state).toBe('active')
  })

  it('prune({ olderThanMs }) removes sessions whose lastSeenAt is too old', async () => {
    const a = new AcpSessionManager({ storePath: defaultAcpSessionStorePath(dir) })
    const s = await a.create({ agentId: 'old' })
    await new Promise((r) => setTimeout(r, 15))
    const fresh = await a.create({ agentId: 'fresh' })
    const removed = await a.prune({ olderThanMs: 5 })
    expect(removed).toContain(s.id)
    expect(removed).not.toContain(fresh.id)
    expect(a.get(s.id)).toBeUndefined()
    expect(a.get(fresh.id)).toBeDefined()
  })

  it('prune({ expired: true }) removes only expired sessions', async () => {
    const path = defaultAcpSessionStorePath(dir)
    const a = new AcpSessionManager({ storePath: path })
    const dead = await a.create({ agentId: 'dead' })
    const b = new AcpSessionManager({ storePath: path, expireAfterMs: 0 })
    await new Promise((r) => setTimeout(r, 5))
    await b.reconcile()
    // After reconcile with 0ms TTL, the existing session is marked expired.
    expect(b.get(dead.id)?.state).toBe('expired')
    const fresh = await b.create({ agentId: 'fresh' })
    const removed = await b.prune({ expired: true })
    expect(removed).toContain(dead.id)
    expect(removed).not.toContain(fresh.id)
  })

  it('prune({ matcher }) accepts a custom predicate', async () => {
    const a = new AcpSessionManager({ storePath: defaultAcpSessionStorePath(dir) })
    await a.create({ agentId: 'a-keep' })
    const drop = await a.create({ agentId: 'b-drop' })
    const removed = await a.prune({ matcher: (s) => s.agentId.startsWith('b-') })
    expect(removed).toEqual([drop.id])
  })
})
