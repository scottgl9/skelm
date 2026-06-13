import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChainAuditWriter, type Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

// The project root lives inside the gateway package so the materialized
// artifact's node_modules symlink resolves `@skelm/core` via the workspace,
// matching what a real install in a real project sees.
const GATEWAY_PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..')

const HELLO_MANIFEST = {
  name: '@skelm/hello',
  version: '0.1.0',
  description: 'Greets someone by name.',
  license: 'MIT',
  skelm: {
    apiVersion: 1,
    requiredSkelmVersion: '>=0.4.0',
    workflows: [
      {
        id: 'default',
        entry: 'workflows/hello.workflow.ts',
        kind: 'pipeline',
        description: 'Greets someone by name.',
      },
    ],
  },
}

const HELLO_WORKFLOW = `import { code, pipeline } from '@skelm/core'

export default pipeline({
  id: 'hello-package',
  steps: [code({ id: 'greet', run: () => ({ greeting: 'hello from package' }) })],
})
`

let projectRoot: string
let stateDir: string
let sourceDir: string
let gw: Gateway | undefined
let base: string

async function writeHelloPackage(dir: string): Promise<void> {
  await mkdir(join(dir, 'workflows'), { recursive: true })
  await writeFile(join(dir, 'skelm.package.json'), JSON.stringify(HELLO_MANIFEST, null, 2))
  await writeFile(join(dir, 'workflows', 'hello.workflow.ts'), HELLO_WORKFLOW)
}

let configPath: string

beforeEach(async () => {
  // mkdtemp under the gateway package dir, not the OS tmpdir, so the package
  // cache's nearest node_modules is the workspace's.
  projectRoot = await mkdtemp(join(GATEWAY_PKG_DIR, '.skelm-pkgrun-proj-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-pkgrun-state-'))
  sourceDir = await mkdtemp(join(tmpdir(), 'skelm-pkgrun-src-'))
  await writeHelloPackage(sourceDir)
  // A real project carries a skelm.config.* at its root; the CLI finds it from
  // the resolved entry's directory and sends its path to start-file. With it
  // present, the project tree (which excludes `.skelm`) would be the naive
  // materialization root — the exact shape that triggered the regression.
  configPath = join(projectRoot, 'skelm.config.mjs')
  await writeFile(configPath, 'export default { defaults: {} }\n')
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    enableHttp: true,
    httpPort: port,
    installSignalHandlers: false,
    watchRegistries: false,
    runStore: new MemoryRunStore(),
    auditWriter: new ChainAuditWriter(join(stateDir, 'audit.jsonl')),
    loadWorkflow: async (_id, absolutePath) => import(pathToFileURL(absolutePath).href),
  }))
  gw = booted.gw
  base = booted.base
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

describe('run an installed workflow package by spec', () => {
  it('install → resolve @scope/name → start-file executes the package entry', async () => {
    // Install the fixture package into the project's .skelm cache.
    const installRes = await fetch(`${base}/v1/packages/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sourceDir }),
    })
    expect(installRes.status).toBe(200)

    // Resolve the run spec exactly as the CLI does.
    const resolveRes = await fetch(`${base}/v1/packages/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: '@skelm/hello' }),
    })
    expect(resolveRes.status).toBe(200)
    const { file } = (await resolveRes.json()) as { file: string }
    // The resolved entry lives inside the gateway-managed package cache.
    expect(file).toContain(join('.skelm', 'packages', '@skelm__hello', '0.1.0'))

    // Start the run from the resolved entry — this is the path that previously
    // failed because the project-tree materializer excludes `.skelm`, dropping
    // the entry from the materialized artifact.
    const startRes = await fetch(`${base}/pipelines/start-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, input: {}, configPath }),
    })
    expect(startRes.status).toBe(200)
    const { runId, pipelineId } = (await startRes.json()) as {
      runId: string
      pipelineId?: string
    }
    expect(pipelineId).toBe('hello-package')

    const deadline = Date.now() + 5_000
    let finalState: { status?: string; output?: unknown; error?: unknown } | null = null
    while (Date.now() < deadline) {
      const r = await fetch(`${base}/runs/${runId}`)
      if (r.ok) {
        finalState = await r.json()
        if (finalState?.status === 'completed' || finalState?.status === 'failed') break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // The whole point: the entry actually executed, not "file not found".
    expect(finalState?.status).toBe('completed')
    expect(finalState?.output).toEqual({ greeting: 'hello from package' })
  })
})
