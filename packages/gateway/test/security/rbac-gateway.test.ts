import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChainAuditWriter, type Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

// Adversarial RBAC suite against the REAL gateway code path + REAL audit
// writer (ChainAuditWriter). No mocking of the gateway: permission enforcement
// is exercised exactly as production runs it. Each test boots a bearer-
// protected gateway whose legacy single token is `root-token` (= ROOT, `*:*`).

const ROOT = 'root-token'

let stateDir: string
let gw: Gateway | undefined
let base: string

async function bootRbacGateway(): Promise<void> {
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    installSignalHandlers: false,
    token: ROOT,
    runStore: new MemoryRunStore(),
    auditWriter: new ChainAuditWriter(join(stateDir, 'audit.jsonl')),
    config: { server: { host: '127.0.0.1', port, auth: { mode: 'bearer' } } },
  }))
  gw = booted.gw
  base = booted.base
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } }
}

async function createToken(body: Record<string, unknown>): Promise<{ secret: string; id: string }> {
  const res = await fetch(
    `${base}/v1/admin/tokens`,
    authed(ROOT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  expect(res.status, 'admin token-create should succeed for root').toBe(200)
  const json = (await res.json()) as { secret: string; token: { id: string } }
  return { secret: json.secret, id: json.token.id }
}

async function readAudit(): Promise<Array<{ action: string; details?: Record<string, unknown> }>> {
  const reader = new ChainAuditWriter(join(stateDir, 'audit.jsonl'))
  return reader.list({ limit: 5000 })
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-rbac-gw-'))
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  await rm(stateDir, { recursive: true, force: true })
})

describe('legacy single token = ROOT (back-compat)', () => {
  it('the legacy token has full access; no scoped tokens issued ⇒ unchanged behaviour', async () => {
    await bootRbacGateway()
    // With no token store yet, every existing route behaves exactly as before.
    expect((await fetch(`${base}/runs`, authed(ROOT))).status).toBe(200)
    expect((await fetch(`${base}/audit`, authed(ROOT))).status).toBe(200)
    // Admin route reachable by root.
    const tokens = await fetch(`${base}/v1/admin/tokens`, authed(ROOT))
    expect(tokens.status).toBe(200)
    // A wrong token is still 401.
    expect((await fetch(`${base}/runs`, authed('WRONG'))).status).toBe(401)
    // No bearer at all is 401.
    expect((await fetch(`${base}/runs`)).status).toBe(401)
  })

  it('root retains full access AFTER scoped tokens exist', async () => {
    await bootRbacGateway()
    await createToken({ roles: ['Viewer'] })
    // Token store is now active, but the legacy root token still bypasses scopes.
    expect((await fetch(`${base}/runs`, authed(ROOT))).status).toBe(200)
    expect((await fetch(`${base}/v1/admin/tokens`, authed(ROOT))).status).toBe(200)
  })
})

describe('scoped token enforcement', () => {
  it('a token WITHOUT the route scope is 403 (audited); WITH it is 200', async () => {
    await bootRbacGateway()
    // Viewer has run:read but NOT audit:read.
    const { secret, id } = await createToken({ roles: ['Viewer'] })

    const denied = await fetch(`${base}/audit`, authed(secret))
    expect(denied.status).toBe(403)

    const allowed = await fetch(`${base}/runs`, authed(secret))
    expect(allowed.status).toBe(200)

    const audit = await readAudit()
    const denial = audit.find(
      (e) => e.action === 'auth.denied' && e.details?.route === 'GET /audit',
    )
    expect(denial, 'auth.denied row for GET /audit').toBeDefined()
    expect(denial?.details?.tokenId).toBe(id)
    expect(denial?.details?.statusCode).toBe(403)
    // The secret must never leak into the audit log.
    expect(JSON.stringify(audit)).not.toContain(secret)
  })

  it('a resource:* token satisfies resource:action', async () => {
    await bootRbacGateway()
    const { secret } = await createToken({ scopes: ['run:*'] })
    expect((await fetch(`${base}/runs`, authed(secret))).status).toBe(200)
  })

  it('an explicit *:* scoped token bypasses the scope map', async () => {
    await bootRbacGateway()
    const { secret } = await createToken({ scopes: ['*:*'] })
    expect((await fetch(`${base}/runs`, authed(secret))).status).toBe(200)
    expect((await fetch(`${base}/audit`, authed(secret))).status).toBe(200)
    expect((await fetch(`${base}/v1/admin/tokens`, authed(secret))).status).toBe(200)
  })

  it('Auditor can read + export audit but is DENIED run/edit/administer', async () => {
    await bootRbacGateway()
    const { secret } = await createToken({ roles: ['Auditor'] })
    expect((await fetch(`${base}/audit`, authed(secret))).status).toBe(200)
    expect((await fetch(`${base}/runs`, authed(secret))).status).toBe(200) // run:read included
    // run:run (start a run by file) — denied.
    const runDenied = await fetch(
      `${base}/runs`,
      authed(secret, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: '/tmp/x.ts' }),
      }),
    )
    expect(runDenied.status).toBe(403)
    // admin:administer — denied.
    const adminDenied = await fetch(
      `${base}/v1/admin/tokens`,
      authed(secret, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roles: ['Viewer'] }),
      }),
    )
    expect(adminDenied.status).toBe(403)
  })

  it('default-deny: an unmapped non-exempt route is 403 for a non-root scoped token', async () => {
    await bootRbacGateway()
    const { secret } = await createToken({ scopes: ['run:read'] })
    const res = await fetch(`${base}/this/route/is/not/mapped`, authed(secret))
    expect(res.status).toBe(403)
    const audit = await readAudit()
    expect(
      audit.some((e) => e.action === 'auth.denied' && e.details?.reason === 'route-unmapped'),
    ).toBe(true)
  })

  it('expired and revoked scoped tokens are 401 (audited, no secret leak)', async () => {
    await bootRbacGateway()
    const expired = await createToken({
      roles: ['Viewer'],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const expiredRes = await fetch(`${base}/runs`, authed(expired.secret))
    expect(expiredRes.status).toBe(401)

    const live = await createToken({ roles: ['Viewer'] })
    const revoke = await fetch(
      `${base}/v1/admin/tokens/${live.id}/revoke`,
      authed(ROOT, { method: 'POST' }),
    )
    expect(revoke.status).toBe(200)
    const revokedRes = await fetch(`${base}/runs`, authed(live.secret))
    expect(revokedRes.status).toBe(401)

    // An unknown bearer (well-formed, not in store, not root) is 401.
    const unknownRes = await fetch(`${base}/runs`, authed('totally-unknown-secret'))
    expect(unknownRes.status).toBe(401)

    const audit = await readAudit()
    const reasons = audit.filter((e) => e.action === 'auth.denied').map((e) => e.details?.reason)
    expect(reasons).toContain('expired')
    expect(reasons).toContain('revoked')
    expect(reasons).toContain('unknown')
    expect(JSON.stringify(audit)).not.toContain(expired.secret)
    expect(JSON.stringify(audit)).not.toContain(live.secret)
  })
})

describe('admin token-management routes', () => {
  it('returns the secret once; the store never returns plaintext again', async () => {
    await bootRbacGateway()
    const { secret, id } = await createToken({ roles: ['Operator'], label: 'ci' })
    expect(secret).toBeTruthy()
    // List returns metadata only — no secret, no hash.
    const list = await (await fetch(`${base}/v1/admin/tokens`, authed(ROOT))).json()
    const found = (list.tokens as Array<Record<string, unknown>>).find((t) => t.id === id)
    expect(found).toBeDefined()
    expect(found).not.toHaveProperty('secretHash')
    expect(found).not.toHaveProperty('salt')
    expect(JSON.stringify(list)).not.toContain(secret)
    expect(found?.label).toBe('ci')
    // The created token-creation event is audited (no secret).
    const audit = await readAudit()
    const created = audit.find((e) => e.action === 'auth.token.created')
    expect(created?.details?.tokenId).toBe(id)
    expect(JSON.stringify(audit)).not.toContain(secret)
  })

  it('rejects invalid roles/scopes with 400', async () => {
    await bootRbacGateway()
    const bad = await fetch(
      `${base}/v1/admin/tokens`,
      authed(ROOT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roles: ['NotARole'] }),
      }),
    )
    expect(bad.status).toBe(400)
  })

  it('revoking an unknown token is 404', async () => {
    await bootRbacGateway()
    const res = await fetch(
      `${base}/v1/admin/tokens/does-not-exist/revoke`,
      authed(ROOT, { method: 'POST' }),
    )
    expect(res.status).toBe(404)
  })
})
