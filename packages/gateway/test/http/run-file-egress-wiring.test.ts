import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type BackendContext, BackendRegistry, type SkelmBackend } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

// Regression: the synchronous/async HTTP run paths (`skelm run` →
// /pipelines/run-file, /pipelines/:id/run, /v1/*) must thread the gateway's
// egress-proxy wiring into Runner.start(), exactly like the trigger
// dispatcher does. Without it, hasEgressProxy is false → a subprocess backend
// (toolPermissions: 'unsupported') is refused even for a networkEgress-only
// policy, and the subprocess gets no HTTP_PROXY so the proxy is bypassed.

// In-tree so `@skelm/core` resolves via workspace symlinks (what real users see).
const NET_ONLY_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/net-egress-only.workflow.mts',
)

// A subprocess-style backend that cannot enforce tool permissions in-process
// (mirrors Pi RPC). It records the proxy env the runtime handed it.
function recordingSubprocessBackend(seen: { proxyEnv?: Record<string, string> }): SkelmBackend {
  return {
    id: 'recording-subprocess',
    capabilities: {
      prompt: true,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'unsupported',
    },
    async run(_request, context: BackendContext) {
      seen.proxyEnv = context.proxyEnv
      return { text: 'ran' }
    },
  }
}

let stateDir: string
let projectRoot: string
let gw: Gateway | undefined
let base: string
const seen: { proxyEnv?: Record<string, string> } = {}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-egress-wiring-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-egress-wiring-root-'))
  const registry = new BackendRegistry()
  registry.register(recordingSubprocessBackend(seen))
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    backends: registry,
    loadWorkflow: async (_id, absolutePath) => import(pathToFileURL(absolutePath).href),
  }))
  gw = booted.gw
  base = booted.base
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  seen.proxyEnv = undefined
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('POST /pipelines/run-file egress wiring', () => {
  it('does not refuse a networkEgress-only step on an egress-unenforceable backend', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: NET_ONLY_FIXTURE, input: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Before the fix this failed with BackendCapabilityError ("cannot enforce
    // declared permissions") because hasEgressProxy was false.
    expect(body.error?.name).not.toBe('BackendCapabilityError')
    expect(body.status).toBe('completed')
  })

  it('injects the gateway egress proxy env into the run', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: NET_ONLY_FIXTURE, input: {} }),
    })
    expect(res.status).toBe(200)
    // The backend must have received HTTP_PROXY pointing at the gateway's
    // egress proxy — proof the wiring reached the runtime, not just the
    // capability check.
    expect(seen.proxyEnv).toBeDefined()
    expect(seen.proxyEnv?.HTTP_PROXY).toMatch(/^http:\/\/.*127\.0\.0\.1:\d+/)
    expect(seen.proxyEnv?.SKELM_EGRESS_TOKEN).toBeTruthy()
  })
})
