import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type BackendContext, BackendRegistry, type SkelmBackend } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

// Executable profiles over the real gateway run path: the operator's
// config.defaults.executableProfiles definitions must thread into
// Runner.start() so a workflow's `executableProfiles` reference expands to
// the profile's executables — and an unknown reference must fail at workflow
// load, before any run starts or a backend executes.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const KNOWN_FIXTURE = join(FIXTURES, 'agent-exec-profile.workflow.mts')
const UNKNOWN_FIXTURE = join(FIXTURES, 'agent-exec-profile-unknown.workflow.mts')

function recordingProfileBackend(seen: {
  ran?: boolean
  allowedExecutables?: readonly string[]
  executableProfileNames?: readonly string[]
}): SkelmBackend {
  return {
    id: 'recording-profile',
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
      seen.ran = true
      seen.allowedExecutables = [...(context.permissions?.allowedExecutables ?? [])]
      seen.executableProfileNames = [...(context.permissions?.executableProfileNames ?? [])]
      return { text: 'ran' }
    },
  }
}

let stateDir: string
let projectRoot: string
let gw: Gateway | undefined
let base: string
const seen: {
  ran?: boolean
  allowedExecutables?: readonly string[]
  executableProfileNames?: readonly string[]
} = {}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-exec-prof-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-exec-prof-root-'))
  const registry = new BackendRegistry()
  registry.register(recordingProfileBackend(seen))
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    backends: registry,
    config: {
      defaults: {
        executableProfiles: {
          gitReadOnly: { description: 'git only', executables: ['git'] },
        },
      },
    },
    loadWorkflow: async (_id, absolutePath) => import(pathToFileURL(absolutePath).href),
  }))
  gw = booted.gw
  base = booted.base
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  seen.ran = undefined
  seen.allowedExecutables = undefined
  seen.executableProfileNames = undefined
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('POST /pipelines/run-file with executable profiles', () => {
  it('expands a configured profile reference into the backend-visible policy', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: KNOWN_FIXTURE, input: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('completed')
    expect(seen.allowedExecutables).toEqual(['git'])
    expect(seen.executableProfileNames).toEqual(['gitReadOnly'])
  })

  it('rejects an unknown profile reference at load, before any run or backend executes', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: UNKNOWN_FIXTURE, input: {} }),
    })
    expect(res.ok).toBe(false)
    const body = await res.json()
    expect(JSON.stringify(body)).toMatch(/unknown executable profile: doesNotExist/)
    expect(seen.ran).toBeUndefined()
    const runs = await fetch(`${base}/runs`)
    if (runs.ok) {
      const list = await runs.json()
      expect(JSON.stringify(list)).not.toMatch(/agent-exec-profile-unknown/)
    }
  })
})
