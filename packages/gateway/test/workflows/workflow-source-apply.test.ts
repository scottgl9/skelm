import { promises as fs } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChainAuditWriter, type Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

// Self-contained workflow source with local builder shims so the gateway's
// real loader (a plain dynamic import) can execute it from a temp project
// root with no package resolution. Plain JS in an .mts file keeps every
// import path (vite-transformed and native) happy. The shims mirror the real
// builders' validation that matters here: wait() rejects timeoutMs < 1.
const FIXTURE = `const pipeline = (def) => {
  if (!Array.isArray(def.steps) || def.steps.length === 0) throw new Error('steps required')
  return def
}
const wait = (def) => {
  if (typeof def.timeoutMs === 'number' && def.timeoutMs < 1) throw new Error('timeoutMs must be >= 1')
  return { kind: 'wait', ...def }
}
const code = (def) => ({ kind: 'code', ...def })

export default pipeline({
  id: 'apply-fixture',
  steps: [
    wait({ id: 'approval', message: 'ok?', timeoutMs: 60000 }),
    code({ id: 'inline', run: () => 1 }),
    code({ id: 'finish', module: './finish.mjs' }),
  ],
})
`

let stateDir: string
let projectRoot: string
let outsideDir: string
let auditPath: string
let wfPath: string
let gw: Gateway | undefined
let base: string
const rmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 25 } as const

beforeEach(async () => {
  stateDir = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-wfapply-')))
  projectRoot = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-wfapply-root-')))
  outsideDir = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-wfapply-out-')))
  auditPath = join(stateDir, 'audit.jsonl')
  wfPath = join(projectRoot, 'workflows', 'apply.workflow.mts')
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  await rm(stateDir, rmOptions)
  await rm(projectRoot, rmOptions)
  await rm(outsideDir, rmOptions)
})

async function bootGateway(opts: { auth?: boolean } = {}): Promise<void> {
  const booted = await bootGatewayWithRetry(async (port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    installSignalHandlers: false,
    runStore: new MemoryRunStore(),
    auditWriter: new ChainAuditWriter(auditPath),
    // Real loader: actually imports the file, so the route's pre-write
    // validation executes the generated source for real.
    loadWorkflow: async (_id: string, path: string) => {
      const { mtimeMs } = await fs.stat(path)
      return await import(`${pathToFileURL(path).href}?v=${mtimeMs}-${Math.random()}`)
    },
    ...(opts.auth === true && { token: 'sekret' }),
    config: {
      ...(opts.auth === true && {
        server: { host: '127.0.0.1', port, auth: { mode: 'bearer' as const } },
      }),
    },
  }))
  gw = booted.gw
  base = booted.base
}

async function registerFixture(headers: Record<string, string> = {}): Promise<void> {
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await writeFile(wfPath, FIXTURE, 'utf8')
  const res = await fetch(`${base}/v1/workflows/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ id: 'apply-fixture', source: { type: 'path', path: wfPath } }),
  })
  expect(res.status).toBe(200)
}

async function postApply(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`${base}/v1/workflows/apply-fixture/source/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function auditRows(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(auditPath, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((row) => row.action === 'workflow.source.apply')
}

async function noProbeLeftBehind(): Promise<void> {
  const names = await readdir(join(projectRoot, 'workflows'))
  expect(names.filter((n) => n.startsWith('.skelm-apply-'))).toEqual([])
}

const SET_TIMEOUT_EDIT = {
  kind: 'setStepField',
  stepId: 'approval',
  field: 'timeoutMs',
  value: 1000,
}

describe('POST /v1/workflows/:id/source/apply', () => {
  it('defaults to dryRun: a call without dryRun returns a diff and writes nothing', async () => {
    await bootGateway()
    await registerFixture()
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(false)
    expect(body.dryRun).toBe(true)
    expect(body.diff).toContain('-')
    expect(String(body.diff)).toContain('timeoutMs: 1000')
    expect(await readFile(wfPath, 'utf8')).toBe(FIXTURE)
    expect(await auditRows()).toEqual([])
    await noProbeLeftBehind()
  })

  it('explicit dryRun: true also writes nothing', async () => {
    await bootGateway()
    await registerFixture()
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT], dryRun: true })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { applied: boolean }).applied).toBe(false)
    expect(await readFile(wfPath, 'utf8')).toBe(FIXTURE)
    expect(await auditRows()).toEqual([])
  })

  it('dryRun: false validates, writes atomically, and audits without the source body', async () => {
    await bootGateway()
    await registerFixture()
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT], dryRun: false })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(true)
    const written = await readFile(wfPath, 'utf8')
    expect(written).toContain('timeoutMs: 1000')
    expect(written).not.toContain('timeoutMs: 60000')
    // codeOwned region untouched
    expect(written).toContain('run: () => 1')
    const rows = await auditRows()
    expect(rows.length).toBe(1)
    const details = (rows[0] as { details: Record<string, unknown> }).details
    expect(details.workflowId).toBe('apply-fixture')
    expect(details.path).toBe(wfPath)
    expect(details.editCount).toBe(1)
    // The audit row must never carry the source body.
    const rawAudit = await readFile(auditPath, 'utf8')
    expect(rawAudit).not.toContain('pipeline(')
    expect(rawAudit).not.toContain('timeoutMs')
    await noProbeLeftBehind()
  })

  it('rejects a code-owned edit with 422 and writes nothing', async () => {
    await bootGateway()
    await registerFixture()
    const res = await postApply({
      edits: [{ kind: 'setStepField', stepId: 'inline', field: 'timeoutMs', value: 5 }],
      dryRun: false,
    })
    expect(res.status).toBe(422)
    expect(await res.text()).toContain('code-owned')
    expect(await readFile(wfPath, 'utf8')).toBe(FIXTURE)
    expect(await auditRows()).toEqual([])
  })

  it('rejects generated source that fails load validation with 422 and writes nothing', async () => {
    await bootGateway()
    await registerFixture()
    // timeoutMs: 0 is a valid JSON literal but the builder rejects it at load.
    const res = await postApply({
      edits: [{ kind: 'setStepField', stepId: 'approval', field: 'timeoutMs', value: 0 }],
      dryRun: false,
    })
    expect(res.status).toBe(422)
    expect(await res.text()).toContain('failed validation')
    expect(await readFile(wfPath, 'utf8')).toBe(FIXTURE)
    expect(await auditRows()).toEqual([])
    await noProbeLeftBehind()
  })

  it('refuses a workflow whose source escapes the allowed roots and audits the denial', async () => {
    await bootGateway()
    await registerFixture()
    // Swap the registered source for a symlink pointing outside the roots —
    // realpath resolution at apply time must refuse it.
    const outsideFile = join(outsideDir, 'evil.workflow.mts')
    await writeFile(outsideFile, FIXTURE, 'utf8')
    await rm(wfPath)
    await symlink(outsideFile, wfPath)
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT], dryRun: false })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('outside the allowed roots')
    expect(await readFile(outsideFile, 'utf8')).toBe(FIXTURE)
    const rows = await auditRows()
    expect(rows.length).toBe(1)
    const details = (rows[0] as { details: Record<string, unknown> }).details
    expect(details.denied).toBe(true)
  })

  it('returns 401 without a bearer token under bearer auth', async () => {
    await bootGateway({ auth: true })
    await registerFixture({ authorization: 'Bearer sekret' })
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT] })
    expect(res.status).toBe(401)
    expect(await readFile(wfPath, 'utf8')).toBe(FIXTURE)
    const authed = await postApply(
      { edits: [SET_TIMEOUT_EDIT] },
      { authorization: 'Bearer sekret' },
    )
    expect(authed.status).toBe(200)
  })

  it('validates the request body', async () => {
    await bootGateway()
    await registerFixture()
    expect((await postApply({})).status).toBe(400)
    expect((await postApply({ edits: [] })).status).toBe(400)
    expect((await postApply({ edits: 'nope' })).status).toBe(400)
    expect((await postApply({ edits: [SET_TIMEOUT_EDIT], dryRun: 'yes' })).status).toBe(400)
    expect(await readFile(wfPath, 'utf8')).toBe(FIXTURE)
  })

  it('returns 404 for an unknown workflow id', async () => {
    await bootGateway()
    const res = await fetch(`${base}/v1/workflows/no-such-workflow/source/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits: [SET_TIMEOUT_EDIT] }),
    })
    expect(res.status).toBe(404)
  })
})
