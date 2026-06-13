import { describe, expect, it } from 'vitest'

import { readProjectInstructions } from '../src/instructions.js'
import { fixtureRepo } from './helpers.js'

describe('readProjectInstructions', () => {
  it('reads AGENTS.md and infers a pnpm stack with a default validation command', async () => {
    const r = await readProjectInstructions(fixtureRepo())
    expect(r.sources).toContain('AGENTS.md')
    expect(r.instructions).toContain('Demo Repo')
    expect(r.stack).toBe('node-pnpm')
    expect(r.inferredValidation).toEqual([['pnpm', 'test']])
  })

  it('reports unknown stack and a placeholder when no instructions exist', async () => {
    const r = await readProjectInstructions('/nonexistent-workspace-path-xyz')
    expect(r.stack).toBe('unknown')
    expect(r.sources).toEqual([])
    expect(r.instructions).toContain('no project instruction files')
    expect(r.inferredValidation).toEqual([])
  })
})
