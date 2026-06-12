import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore, branch, code, parallel, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string
let projectRoot: string
const rmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 25 } as const

beforeEach(async () => {
  stateDir = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-wfgraph-')))
  projectRoot = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-wfgraph-root-')))
})

afterEach(async () => {
  await rm(stateDir, rmOptions)
  await rm(projectRoot, rmOptions)
})

const fixture = pipeline({
  id: 'graph-fixture',
  version: '1.0.0',
  steps: [
    parallel({
      id: 'fan-out',
      steps: [code({ id: 'left', run: () => 'l' }), code({ id: 'right', run: () => 'r' })],
    }),
    branch({
      id: 'route',
      on: () => 'a',
      cases: { a: code({ id: 'a-path', run: () => 1 }) },
    }),
  ],
})

async function bootGateway(opts: { auth?: boolean } = {}): Promise<{ gw: Gateway; base: string }> {
  return await bootGatewayWithRetry(async (port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
    loadWorkflow: async () => fixture,
    ...(opts.auth === true && { token: 'sekret' }),
    config: {
      ...(opts.auth === true && {
        server: { host: '127.0.0.1', port, auth: { mode: 'bearer' as const } },
      }),
      registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
    },
  }))
}

async function registerFixture(base: string): Promise<void> {
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  const wfPath = join(projectRoot, 'workflows/a.workflow.ts')
  await fs.writeFile(wfPath, 'export default {}')
  const res = await fetch(`${base}/v1/workflows/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'graph-fixture', source: { type: 'path', path: wfPath } }),
  })
  expect(res.status).toBe(200)
}

describe('GET /v1/workflows/:id/graph', () => {
  it('returns the derived WorkflowGraph for a registered workflow', async () => {
    const { gw, base } = await bootGateway()
    try {
      await registerFixture(base)
      const res = await fetch(`${base}/v1/workflows/graph-fixture/graph`)
      expect(res.status).toBe(200)
      const graph = await res.json()
      expect(graph.id).toBe('graph-fixture')
      expect(graph.kind).toBe('pipeline')
      expect(graph.version).toBe('1.0.0')
      expect(graph.nodes.map((n: { id: string }) => n.id)).toEqual(['fan-out', 'route'])
      const fanOut = graph.nodes[0]
      expect(fanOut.children.map((c: { id: string }) => c.id)).toEqual(['left', 'right'])
      const route = graph.nodes[1]
      expect(route.codeOwned).toBe(true)
      expect(route.children[0].data.case).toBe('a')
      expect(graph.edges).toEqual([{ from: 'fan-out', to: 'route', kind: 'control' }])
    } finally {
      await gw.stop()
    }
  })

  it('returns 404 for an unknown workflow', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/workflows/does-not-exist/graph`)
      expect(res.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })

  it('returns 401 without a bearer token under bearer auth', async () => {
    const { gw, base } = await bootGateway({ auth: true })
    try {
      const res = await fetch(`${base}/v1/workflows/graph-fixture/graph`)
      expect(res.status).toBe(401)
      const authed = await fetch(`${base}/v1/workflows/graph-fixture/graph`, {
        headers: { authorization: 'Bearer sekret' },
      })
      expect(authed.status).not.toBe(401)
    } finally {
      await gw.stop()
    }
  })
})
