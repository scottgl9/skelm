import { promises as fs } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

// Runnable variant: no wait step, so POST /pipelines/:id/run completes. The
// 'finish' step is module-backed — a declarative field the round-trip may
// edit — and baseDir pins module resolution to the importing file's own
// directory, i.e. the managed revision tree the gateway loaded it from.
const RUN_FIXTURE = `const pipeline = (def) => def
const code = (def) => ({ kind: 'code', ...def })

export default pipeline({
  id: 'run-fixture',
  baseDir: new URL('.', import.meta.url).pathname,
  steps: [
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
      registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
    },
  }))
  gw = booted.gw
  base = booted.base
}

async function registerFixture(
  idOrHeaders: string | Record<string, string> = 'apply-fixture',
  maybeHeaders: Record<string, string> = {},
): Promise<{ sourcePath: string }> {
  const id = typeof idOrHeaders === 'string' ? idOrHeaders : 'apply-fixture'
  const headers = typeof idOrHeaders === 'string' ? maybeHeaders : idOrHeaders
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await writeFile(wfPath, FIXTURE, 'utf8')
  const res = await fetch(`${base}/v1/workflows/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ id, source: { type: 'path', path: wfPath } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { workflow: { sourcePath: string; sourceKind: string } }
  expect(body.workflow.sourceKind).toBe('managed')
  return { sourcePath: body.workflow.sourcePath }
}

async function postApply(
  body: unknown,
  headers: Record<string, string> = {},
  id = 'apply-fixture',
): Promise<Response> {
  return await fetch(`${base}/v1/workflows/${encodeURIComponent(id)}/source/apply`, {
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

function revisionsDir(id = 'apply-fixture'): string {
  return join(stateDir, 'managed-workflows', encodeURIComponent(id))
}

async function listRevisions(id = 'apply-fixture'): Promise<string[]> {
  return await readdir(revisionsDir(id)).catch(() => [])
}

async function noProbeLeftBehind(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [])
  expect(names.filter((n) => n.startsWith('.skelm-apply-'))).toEqual([])
}

const SET_TIMEOUT_EDIT = {
  kind: 'setStepField',
  stepId: 'approval',
  field: 'timeoutMs',
  value: 1000,
}

describe('POST /v1/workflows/:id/source/apply', () => {
  it('defaults to dryRun: a call without dryRun returns a diff and mutates nothing', async () => {
    await bootGateway()
    const { sourcePath } = await registerFixture()
    const revisionsBefore = await listRevisions()
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(false)
    expect(body.dryRun).toBe(true)
    expect(String(body.diff)).toContain('timeoutMs: 1000')
    // No new revision, managed copy untouched, author file untouched.
    expect(await listRevisions()).toEqual(revisionsBefore)
    expect(await readFile(sourcePath, 'utf8')).toBe(FIXTURE)
    expect(await readFile(wfPath, 'utf8')).toBe(FIXTURE)
    expect(await auditRows()).toEqual([])
    await noProbeLeftBehind(dirname(sourcePath))
  })

  it('explicit dryRun: true also mutates nothing', async () => {
    await bootGateway()
    const { sourcePath } = await registerFixture()
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT], dryRun: true })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { applied: boolean }).applied).toBe(false)
    expect(await readFile(sourcePath, 'utf8')).toBe(FIXTURE)
    expect(await auditRows()).toEqual([])
  })

  it('dryRun: false cuts a new managed revision, repoints the registration, retains the old revision, and audits without the source body', async () => {
    await bootGateway()
    const { sourcePath: oldEntry } = await registerFixture()
    const revisionsBefore = await listRevisions()
    expect(revisionsBefore.length).toBe(1)

    const res = await postApply({ edits: [SET_TIMEOUT_EDIT], dryRun: false })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(true)
    expect(typeof body.revision).toBe('string')

    // New revision created; the OLD revision dir is retained for in-flight
    // runs and its entry still carries the pre-edit source.
    const revisionsAfter = await listRevisions()
    expect(revisionsAfter.length).toBe(2)
    expect(revisionsAfter).toContain(body.revision)
    expect(await readFile(oldEntry, 'utf8')).toBe(FIXTURE)

    // The registration record and registry now point at the new revision.
    const record = JSON.parse(
      await readFile(join(stateDir, 'registered-workflows', 'apply-fixture.json'), 'utf8'),
    ) as { sourcePath: string; sourceKind: string }
    expect(record.sourceKind).toBe('managed')
    expect(record.sourcePath).not.toBe(oldEntry)
    expect(record.sourcePath).toContain(`${body.revision}`)
    const edited = await readFile(record.sourcePath, 'utf8')
    expect(edited).toContain('timeoutMs: 1000')
    expect(edited).not.toContain('timeoutMs: 60000')
    // codeOwned region preserved byte-for-byte.
    expect(edited).toContain('run: () => 1')
    const listed = (await fetch(`${base}/v1/workflows`).then((r) => r.json())) as Array<{
      id: string
      file: string
    }>
    expect(listed.find((e) => e.id === 'apply-fixture')?.file).toBe(record.sourcePath)

    // The authored host file is metadata only — never written.
    expect(await readFile(wfPath, 'utf8')).toBe(FIXTURE)

    const rows = await auditRows()
    expect(rows.length).toBe(1)
    const details = (rows[0] as { details: Record<string, unknown> }).details
    expect(details.workflowId).toBe('apply-fixture')
    expect(details.sourceKind).toBe('managed')
    expect(details.editCount).toBe(1)
    expect(details.revision).toBe(body.revision)
    // The audit row must never carry the source body.
    const rawAudit = await readFile(auditPath, 'utf8')
    expect(rawAudit).not.toContain('pipeline(')
    expect(rawAudit).not.toContain('timeoutMs')
    await noProbeLeftBehind(dirname(oldEntry))
    await noProbeLeftBehind(dirname(record.sourcePath))
  })

  it('a run after apply executes the edited managed revision', async () => {
    await bootGateway()
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    const runPath = join(projectRoot, 'workflows', 'run.workflow.mts')
    await writeFile(runPath, RUN_FIXTURE, 'utf8')
    await writeFile(
      join(projectRoot, 'workflows', 'finish.mjs'),
      "export default () => 'first'\n",
      'utf8',
    )
    await writeFile(
      join(projectRoot, 'workflows', 'finish2.mjs'),
      "export default () => 'second'\n",
      'utf8',
    )
    const reg = await fetch(`${base}/v1/workflows/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'run-fixture', source: { type: 'path', path: runPath } }),
    })
    expect(reg.status).toBe(200)

    const before = await fetch(`${base}/pipelines/run-fixture/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    })
    expect(before.status).toBe(200)
    expect(((await before.json()) as { output: unknown }).output).toBe('first')

    const apply = await postApply(
      {
        edits: [
          { kind: 'setStepField', stepId: 'finish', field: 'module', value: './finish2.mjs' },
        ],
        dryRun: false,
      },
      {},
      'run-fixture',
    )
    expect(apply.status).toBe(200)

    const after = await fetch(`${base}/pipelines/run-fixture/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    })
    expect(after.status).toBe(200)
    const result = (await after.json()) as { status: string; output: unknown }
    expect(result.status).toBe('completed')
    expect(result.output).toBe('second')
  })

  it("legacy 'path' record: apply writes the host file atomically and audits", async () => {
    // Forge a pre-managed-era record on disk; loadFromDisk replays it at boot.
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await writeFile(wfPath, FIXTURE, 'utf8')
    await fs.mkdir(join(stateDir, 'registered-workflows'), { recursive: true })
    await writeFile(
      join(stateDir, 'registered-workflows', 'apply-fixture.json'),
      JSON.stringify({
        id: 'apply-fixture',
        sourcePath: wfPath,
        sourceKind: 'path',
        registeredAt: new Date().toISOString(),
      }),
      'utf8',
    )
    await bootGateway()
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT], dryRun: false })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.applied).toBe(true)
    expect(body.revision).toBeUndefined()
    const written = await readFile(wfPath, 'utf8')
    expect(written).toContain('timeoutMs: 1000')
    expect(written).not.toContain('timeoutMs: 60000')
    expect(written).toContain('run: () => 1')
    // No managed revision is cut for a 'path' record.
    expect(await listRevisions()).toEqual([])
    const rows = await auditRows()
    expect(rows.length).toBe(1)
    const details = (rows[0] as { details: Record<string, unknown> }).details
    expect(details.workflowId).toBe('apply-fixture')
    expect(details.sourceKind).toBe('path')
    expect(details.editCount).toBe(1)
    const rawAudit = await readFile(auditPath, 'utf8')
    expect(rawAudit).not.toContain('pipeline(')
    await noProbeLeftBehind(dirname(wfPath))
  })

  it('rejects a code-owned edit with 422 — no write, no new revision', async () => {
    await bootGateway()
    const { sourcePath } = await registerFixture()
    const res = await postApply({
      edits: [{ kind: 'setStepField', stepId: 'inline', field: 'timeoutMs', value: 5 }],
      dryRun: false,
    })
    expect(res.status).toBe(422)
    expect(await res.text()).toContain('code-owned')
    expect((await listRevisions()).length).toBe(1)
    expect(await readFile(sourcePath, 'utf8')).toBe(FIXTURE)
    expect(await auditRows()).toEqual([])
  })

  it('rejects generated source that fails load validation with 422 — no write, no leftovers', async () => {
    await bootGateway()
    const { sourcePath } = await registerFixture()
    // timeoutMs: 0 is a valid JSON literal but the builder rejects it at load.
    const res = await postApply({
      edits: [{ kind: 'setStepField', stepId: 'approval', field: 'timeoutMs', value: 0 }],
      dryRun: false,
    })
    expect(res.status).toBe(422)
    expect(await res.text()).toContain('failed validation')
    expect((await listRevisions()).length).toBe(1)
    expect(await readFile(sourcePath, 'utf8')).toBe(FIXTURE)
    expect(await auditRows()).toEqual([])
    await noProbeLeftBehind(dirname(sourcePath))
    // No staging dir left beside the revisions either.
    const stray = (await readdir(join(stateDir, 'managed-workflows'))).filter((n) =>
      n.includes('.tmp-'),
    )
    expect(stray).toEqual([])
  })

  it('refuses a workflow whose source escapes the allowed roots and audits the denial', async () => {
    // Glob-discovered workflow (no record): its authored file IS the
    // executable source. Swap it for a symlink pointing outside the roots —
    // realpath re-validation at apply time must refuse it.
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await writeFile(wfPath, FIXTURE, 'utf8')
    await bootGateway()
    const outsideFile = join(outsideDir, 'evil.workflow.mts')
    await writeFile(outsideFile, FIXTURE, 'utf8')
    await rm(wfPath)
    await symlink(outsideFile, wfPath)
    const res = await postApply(
      { edits: [SET_TIMEOUT_EDIT], dryRun: false },
      {},
      'workflows/apply.workflow.mts',
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('outside the allowed roots')
    expect(await readFile(outsideFile, 'utf8')).toBe(FIXTURE)
    const rows = await auditRows()
    expect(rows.length).toBe(1)
    const details = (rows[0] as { details: Record<string, unknown> }).details
    expect(details.denied).toBe(true)
    expect(details.workflowId).toBe('workflows/apply.workflow.mts')
  })

  it('does not execute an out-of-roots symlink while resolving an authored workflow id', async () => {
    await bootGateway()
    const marker = join(outsideDir, 'executed.txt')
    const aliasPath = join(projectRoot, 'manual', 'apply-source.mts')
    await fs.mkdir(join(projectRoot, 'manual'), { recursive: true })
    await writeFile(aliasPath, FIXTURE, 'utf8')
    const reg = await fetch(`${base}/v1/workflows/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'managed-alias', source: { type: 'path', path: aliasPath } }),
    })
    expect(reg.status).toBe(200)
    const { workflow } = (await reg.json()) as {
      workflow: { sourcePath: string; sourceKind: string }
    }
    const sourcePath = workflow.sourcePath
    const outsideFile = join(outsideDir, 'evil.workflow.mts')
    await writeFile(
      outsideFile,
      `import { writeFileSync } from 'node:fs'

writeFileSync(${JSON.stringify(marker)}, 'executed', 'utf8')

const pipeline = (def) => def

export default pipeline({
  id: 'apply-fixture',
  steps: [{ kind: 'wait', id: 'approval', message: 'ok?', timeoutMs: 60000 }],
})
`,
      'utf8',
    )
    await rm(sourcePath)
    await symlink(outsideFile, sourcePath)

    const res = await postApply({ edits: [SET_TIMEOUT_EDIT], dryRun: false }, {}, 'apply-fixture')
    expect(res.status).toBe(404)
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(outsideFile, 'utf8')).toContain('writeFileSync(')
  })

  it('returns 401 without a bearer token under bearer auth', async () => {
    await bootGateway({ auth: true })
    const { sourcePath } = await registerFixture({ authorization: 'Bearer sekret' })
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT] })
    expect(res.status).toBe(401)
    expect(await readFile(sourcePath, 'utf8')).toBe(FIXTURE)
    const authed = await postApply(
      { edits: [SET_TIMEOUT_EDIT] },
      { authorization: 'Bearer sekret' },
    )
    expect(authed.status).toBe(200)
  })

  it('validates the request body', async () => {
    await bootGateway()
    const { sourcePath } = await registerFixture()
    expect((await postApply({})).status).toBe(400)
    expect((await postApply({ edits: [] })).status).toBe(400)
    expect((await postApply({ edits: 'nope' })).status).toBe(400)
    expect((await postApply({ edits: [SET_TIMEOUT_EDIT], dryRun: 'yes' })).status).toBe(400)
    expect(await readFile(sourcePath, 'utf8')).toBe(FIXTURE)
    expect((await listRevisions()).length).toBe(1)
  })

  it('returns 404 for an unknown workflow id', async () => {
    await bootGateway()
    const res = await postApply({ edits: [SET_TIMEOUT_EDIT] }, {}, 'no-such-workflow')
    expect(res.status).toBe(404)
  })
})
