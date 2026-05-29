import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootGatewayWithRetry } from './utils/boot-gateway.js'

// Auth-fail sweep across the gateway HTTP route surface. The audit
// flagged that 14 of 16 route files lacked the documented
// happy / auth-fail / validation-fail trio. This file consolidates the
// auth-fail leg into a single suite that boots one bearer-protected
// gateway and asserts an unauthenticated request to one representative
// endpoint from each route module returns 401.
//
// Happy-path and validation-fail coverage live in the individual route
// test files (existing or follow-up); this suite's job is to prove the
// auth middleware applies *uniformly* — a route added without an
// explicit opt-out should be covered automatically.

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-auth-sweep-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('Gateway auth middleware — uniform 401 on missing/bad token', () => {
  it('every protected route returns 401 without a bearer header', async () => {
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      token: 'sekret',
      config: { server: { host: '127.0.0.1', port, auth: { mode: 'bearer' } } },
    }))
    // Representative endpoint per route module. /healthz and /readyz are
    // also auth-gated under bearer mode so health probes should send the
    // token; if you want anonymous probes use an unprotected sidecar.
    const probes: Array<{ name: string; method: string; path: string }> = [
      { name: 'approvals', method: 'GET', path: '/approvals' },
      { name: 'config', method: 'GET', path: '/config' },
      { name: 'dashboard', method: 'GET', path: '/v1/dashboard/overview' },
      { name: 'debug', method: 'GET', path: '/debug/breakpoints' },
      { name: 'gateway-lifecycle', method: 'POST', path: '/gateway/pause' },
      { name: 'health', method: 'GET', path: '/health' },
      { name: 'healthz', method: 'GET', path: '/healthz' },
      { name: 'readyz', method: 'GET', path: '/readyz' },
      { name: 'metrics', method: 'GET', path: '/metrics' },
      { name: 'projects', method: 'POST', path: '/v1/projects/activate' },
      { name: 'active', method: 'GET', path: '/v1/active' },
      { name: 'deactivate', method: 'POST', path: '/v1/workflows/x/deactivate' },
      { name: 'tui', method: 'POST', path: '/v1/tui/x/submit' },
      { name: 'runs', method: 'GET', path: '/runs' },
      { name: 'schedules', method: 'GET', path: '/schedules' },
      { name: 'sessions', method: 'GET', path: '/sessions' },
      { name: 'triggers', method: 'GET', path: '/triggers' },
      { name: 'workflows', method: 'GET', path: '/workflows' },
    ]
    try {
      for (const probe of probes) {
        const res = await fetch(`${base}${probe.path}`, { method: probe.method })
        expect(res.status, `${probe.name} ${probe.method} ${probe.path}`).toBe(401)
      }
      // And every probe succeeds (200, 404, or 400 — all post-auth)
      // when the token is supplied. Exact code depends on route shape;
      // the contract here is "auth passed → not 401".
      for (const probe of probes) {
        const res = await fetch(`${base}${probe.path}`, {
          method: probe.method,
          headers: { authorization: 'Bearer sekret' },
        })
        expect(res.status, `${probe.name} authed`).not.toBe(401)
      }
    } finally {
      await gw.stop()
    }
  })

  it('a wrong bearer token is also 401 (timing-safe compare)', async () => {
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      token: 'sekret',
      config: { server: { host: '127.0.0.1', port, auth: { mode: 'bearer' } } },
    }))
    try {
      const res = await fetch(`${base}/health`, {
        headers: { authorization: 'Bearer NOT-THE-TOKEN' },
      })
      expect(res.status).toBe(401)
    } finally {
      await gw.stop()
    }
  })
})
