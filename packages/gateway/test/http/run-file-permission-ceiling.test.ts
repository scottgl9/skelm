import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type BackendContext, BackendRegistry, type SkelmBackend } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

// Regression: the registered-pipeline HTTP run paths (POST /pipelines/run-file,
// /pipelines/:id/run, the async sibling, and the OpenAI-compat /v1/* path via
// pipeline-runner) must thread the operator's config.defaults.permissions
// ceiling into Runner.start(), exactly like the trigger dispatcher, persistent
// turns, and #startRunnerAsync do. Pre-fix these paths spread only
// egressRunOptions() + agentmemoryRunOptions(), so an operator-declared ceiling
// was SILENTLY DROPPED here — a permission-ceiling bypass: a workflow run via
// `skelm run`→gateway or POST /pipelines/:id/run escaped the operator ceiling
// entirely. Surfaced end-to-end by skelm-self-test s100-operator-ceiling-parity.

const CEILING_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/agent-exec-ceiling.workflow.mts',
)

function recordingCeilingBackend(seen: { allowedExecutables?: readonly string[] }): SkelmBackend {
  return {
    id: 'recording-ceiling',
    capabilities: {
      prompt: true,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'native',
    },
    async run(_request, context: BackendContext) {
      seen.allowedExecutables = [...(context.permissions?.allowedExecutables ?? [])]
      return { text: 'ran' }
    },
  }
}

let stateDir: string
let projectRoot: string
let gw: Gateway | undefined
let base: string
const seen: { allowedExecutables?: readonly string[] } = {}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-ceiling-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-ceiling-root-'))
  const registry = new BackendRegistry()
  registry.register(recordingCeilingBackend(seen))
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    backends: registry,
    // Operator-wide ceiling: narrows allowedExecutables to just 'node'.
    config: {
      defaults: { permissions: { networkEgress: 'allow', allowedExecutables: ['node'] } },
    },
    loadWorkflow: async (_id, absolutePath) => import(pathToFileURL(absolutePath).href),
  }))
  gw = booted.gw
  base = booted.base
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  seen.allowedExecutables = undefined
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('POST /pipelines/run-file operator-ceiling enforcement', () => {
  it('intersects config.defaults.permissions into the run (ceiling not dropped)', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: CEILING_FIXTURE, input: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('completed')
    // The agent declared ['skelm','node']; the operator ceiling permits only
    // ['node']. Pre-fix the ceiling was dropped on this run path and the backend
    // saw ['skelm','node']. Post-fix the intersection binds → ['node'].
    expect(seen.allowedExecutables).toEqual(['node'])
  })
})
