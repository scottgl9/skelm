import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { Gateway } from '@skelm/gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncDeclaredTriggers } from '../src/gateway.js'
import type { MainIO } from '../src/main.js'

// PR #165 follow-up: pin the reconcile/sweep paths of `syncDeclaredTriggers`
// that the first round of fixes added but never tested. These cover:
//   - spec drift on an existing declared trigger → unregister + re-register
//   - trigger removed from a still-live workflow → sweep
//   - workflow file disappeared entirely → sweep
//   - operator-managed registrations (declared !== true) survive sweep,
//     including ids that contain `#` (the previous heuristic would have
//     silently destroyed `nightly#backup`)
//
// Note on the test pattern: Node's ESM resolver caches modules by URL, so
// editing the same workflow file in-place and re-calling import() returns
// the stale module. To exercise the "spec drift" branch deterministically,
// we seed the stale registration directly via `coordinator.register` and
// then call `syncDeclaredTriggers`, which performs the *first* import() of
// the file on disk (no cache hit). This pins the reconcile semantics
// without depending on FS cache invalidation.

const ioStub: MainIO = {
  stdin: process.stdin,
  stdout: new Writable({ write: (_c, _e, cb) => cb() }),
  stderr: new Writable({ write: (_c, _e, cb) => cb() }),
  env: process.env,
  cwd: () => process.cwd(),
}

let projectRoot: string
let stateDir: string
let gw: Gateway

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-sync-pr-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-sync-st-'))
  await mkdir(join(projectRoot, 'workflows'), { recursive: true })
  gw = new Gateway({
    stateDir,
    projectRoot,
    watchRegistries: false,
    config: { registries: { workflows: { glob: 'workflows/**/*.workflow.ts' } } },
  })
  await gw.start()
})

afterEach(async () => {
  await gw.stop().catch(() => {})
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

// Hand-rolled workflow module: emit a plain default-export literal with
// the shape syncDeclaredTriggers reads. Avoids the @skelm/core import
// resolution problem from a tempdir; the function never executes the
// pipeline's steps, only its `default.triggers` array.
async function writeWorkflow(
  fileName: string,
  pipelineId: string,
  triggers: Array<Record<string, unknown>>,
): Promise<string> {
  const path = join(projectRoot, 'workflows', fileName)
  const src = `export default { id: ${JSON.stringify(pipelineId)}, triggers: ${JSON.stringify(
    triggers,
  )} }\n`
  await writeFile(path, src)
  return path
}

describe('syncDeclaredTriggers — reconcile and sweep (PR #165 follow-up)', () => {
  it('replaces a registered trigger when the declared spec drifts', async () => {
    // Seed the coordinator with a "stale" registration as if the previous
    // boot had loaded a workflow with tz=UTC. The workflow file on disk
    // declares tz=America/Chicago — sync must replace.
    gw.managers.triggers.register(
      {
        kind: 'cron',
        id: 'workflows/drift.workflow.ts#cron',
        workflowId: 'workflows/drift.workflow.ts',
        cron: '0 9 * * *',
        tz: 'UTC',
      },
      undefined,
      { declared: true },
    )
    const before = gw.managers.triggers.get('workflows/drift.workflow.ts#cron')
    expect(before?.declared).toBe(true)
    if (before?.spec.kind === 'cron') expect(before.spec.tz).toBe('UTC')

    await writeWorkflow('drift.workflow.ts', 'drift', [
      { kind: 'cron', cron: '0 9 * * *', tz: 'America/Chicago' },
    ])
    await gw.registries.workflows.refresh()
    const armed = await syncDeclaredTriggers(gw, ioStub)
    expect(armed).toBe(1)

    const after = gw.managers.triggers.get('workflows/drift.workflow.ts#cron')
    expect(after).toBeDefined()
    expect(after?.declared).toBe(true)
    if (after?.spec.kind === 'cron') expect(after.spec.tz).toBe('America/Chicago')
  })

  it('sweeps a declared trigger removed from a still-live workflow', async () => {
    // Workflow on disk declares ONE trigger. We seed the coordinator with
    // a stale extra declared trigger as if its prior `triggers:` entry
    // had been removed — sync must sweep the orphan and keep the live one.
    gw.managers.triggers.register(
      {
        kind: 'cron',
        id: 'workflows/shrunk.workflow.ts#cron',
        workflowId: 'workflows/shrunk.workflow.ts',
        cron: '0 1 * * *',
      },
      undefined,
      { declared: true },
    )
    gw.managers.triggers.register(
      {
        kind: 'cron',
        id: 'workflows/shrunk.workflow.ts#cron-1',
        workflowId: 'workflows/shrunk.workflow.ts',
        cron: '0 2 * * *',
      },
      undefined,
      { declared: true },
    )
    await writeWorkflow('shrunk.workflow.ts', 'shrunk', [{ kind: 'cron', cron: '0 1 * * *' }])
    await gw.registries.workflows.refresh()
    await syncDeclaredTriggers(gw, ioStub)

    expect(gw.managers.triggers.get('workflows/shrunk.workflow.ts#cron')).toBeDefined()
    // The trigger removed from the live workflow's array is gone.
    expect(gw.managers.triggers.get('workflows/shrunk.workflow.ts#cron-1')).toBeUndefined()
  })

  it('sweeps declared triggers whose backing workflow file disappeared', async () => {
    gw.managers.triggers.register(
      {
        kind: 'cron',
        id: 'workflows/gone.workflow.ts#cron',
        workflowId: 'workflows/gone.workflow.ts',
        cron: '0 1 * * *',
      },
      undefined,
      { declared: true },
    )
    // Registry is empty (no workflow file on disk). Sync should sweep
    // the orphan trigger.
    await gw.registries.workflows.refresh()
    await syncDeclaredTriggers(gw, ioStub)
    expect(gw.managers.triggers.get('workflows/gone.workflow.ts#cron')).toBeUndefined()
  })

  it('preserves operator-managed schedules with # in id when their workflow is absent', async () => {
    // Operator registers a schedule directly (POST /schedules path) — no
    // declared flag. The id contains `#`, which the previous heuristic
    // would have misclassified as a declared trigger and unregistered.
    gw.managers.triggers.register({
      kind: 'cron',
      id: 'nightly#backup',
      workflowId: 'never-discovered',
      cron: '0 0 * * *',
    })
    expect(gw.managers.triggers.get('nightly#backup')?.declared).toBeUndefined()

    await gw.registries.workflows.refresh()
    await syncDeclaredTriggers(gw, ioStub)

    // Survives reload even though its workflowId never appears in the
    // registry — preserved purely because `reg.declared !== true`.
    expect(gw.managers.triggers.get('nightly#backup')).toBeDefined()
  })

  it('preserves operator-managed schedules while reconciling a declared trigger drift', async () => {
    // Mix: one declared trigger (seeded as stale) + one operator
    // schedule. After sync, the declared one reconciles; the operator
    // one is untouched.
    gw.managers.triggers.register(
      {
        kind: 'cron',
        id: 'workflows/mixed.workflow.ts#cron',
        workflowId: 'workflows/mixed.workflow.ts',
        cron: '0 9 * * *',
        tz: 'UTC',
      },
      undefined,
      { declared: true },
    )
    gw.managers.triggers.register({
      kind: 'cron',
      id: 'mixed-operator',
      workflowId: 'workflows/mixed.workflow.ts',
      cron: '*/15 * * * *',
    })

    await writeWorkflow('mixed.workflow.ts', 'mixed', [
      { kind: 'cron', cron: '0 9 * * *', tz: 'America/Chicago' },
    ])
    await gw.registries.workflows.refresh()
    await syncDeclaredTriggers(gw, ioStub)

    const declared = gw.managers.triggers.get('workflows/mixed.workflow.ts#cron')
    const operator = gw.managers.triggers.get('mixed-operator')
    expect(declared).toBeDefined()
    if (declared?.spec.kind === 'cron') expect(declared.spec.tz).toBe('America/Chicago')
    expect(operator).toBeDefined()
    expect(operator?.declared).toBeUndefined()
  })
})
