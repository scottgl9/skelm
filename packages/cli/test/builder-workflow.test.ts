import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { AgentStep } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { loadWorkflowFromFile } from '../src/load-workflow.js'
import { main } from '../src/main.js'

// Repo-root builder/ (packages/cli/test -> ../../../builder).
const BUILDER = join(import.meta.dirname, '..', '..', '..', 'builder', 'builder.workflow.mts')

describe('builder workflow', () => {
  it('exposes the expected pipeline shape', async () => {
    const wf = await loadWorkflowFromFile(BUILDER)
    expect(wf.id).toBe('skelm-builder')
    expect(wf.inputSchema).toBeDefined()
    expect(wf.outputSchema).toBeDefined()
    expect(wf.steps.map((s) => s.id)).toEqual(['ask-spec', 'build'])
    expect(wf.steps.map((s) => s.kind)).toEqual(['wait', 'agent'])
  })

  it('declares least-privilege permissions on the agent step', async () => {
    const wf = await loadWorkflowFromFile(BUILDER)
    const build = wf.steps.find((s) => s.id === 'build') as AgentStep
    expect(build.permissions).toBeDefined()
    expect(build.permissions?.allowedSkills).toContain('skelm')
    expect(build.permissions?.fsWrite?.length).toBeGreaterThan(0)
    // The builder reaches the LLM endpoint via the backend, not a tool — no egress.
    expect(build.permissions?.networkEgress).toBe('deny')
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
