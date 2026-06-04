import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { PersistentWorkflow } from '@skelm/core'
import { isPersistentWorkflow } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { loadWorkflowFromFile } from '../src/load-workflow.js'
import { main } from '../src/main.js'

// Repo-root builder/ (packages/cli/test -> ../../../builder).
const BUILDER = join(import.meta.dirname, '..', '..', '..', 'builder', 'builder.workflow.mts')

describe('builder workflow', () => {
  it('exposes the expected persistent-workflow shape', async () => {
    const wf = await loadWorkflowFromFile(BUILDER)
    expect(wf.id).toBe('skelm-builder')
    expect(isPersistentWorkflow(wf)).toBe(true)
    const pwf = wf as PersistentWorkflow
    expect(pwf.triggers).toContainEqual({ kind: 'queue', sourceId: 'tui' })
  })

  it('declares least-privilege permissions on the persistent agent', async () => {
    const wf = await loadWorkflowFromFile(BUILDER)
    const perms = (wf as PersistentWorkflow).agent.permissions
    expect(perms).toBeDefined()
    expect(perms?.allowedSkills).toContain('skelm')
    expect(perms?.fsWrite?.length).toBeGreaterThan(0)
    expect(perms?.allowedExecutables).toContain('bash')
    // The codex→pi-sdk routing's in-process pi-sdk failover cannot enforce a
    // narrower egress policy, so the agent grants 'allow' (the honest contract).
    expect(perms?.networkEgress).toBe('allow')
  })

  it('teaches generated code steps to read ctx.input and runtime-check deterministic examples', async () => {
    const wf = await loadWorkflowFromFile(BUILDER)
    const system = (wf as PersistentWorkflow).agent.system
    expect(system).toContain('For code() steps, run receives a context object')
    expect(system).toContain('Read user input from ctx.input')
    expect(system).toContain('run the workflow once with representative JSON input')
  })

  it('passes skelm validate', async () => {
    const r = await invoke(['validate', BUILDER])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).toMatch(/ok:/)
  })
})

async function invoke(argv: readonly string[]) {
  const out: string[] = []
  const err: string[] = []
  const stdout = new Writable({
    write(c, _e, cb) {
      out.push(c.toString())
      cb()
    },
  })
  const stderr = new Writable({
    write(c, _e, cb) {
      err.push(c.toString())
      cb()
    },
  })
  const result = await main(argv, { stdout, stderr, stdin: Readable.from([]) })
  return { stdout: out.join(''), stderr: err.join(''), exitCode: result.exitCode }
}
