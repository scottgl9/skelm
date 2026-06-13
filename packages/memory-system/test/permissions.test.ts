import { ALL_AGENTMEMORY_OPS, type AgentmemoryOperation } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { type MemoryWorkflowId, WORKFLOW_PERMISSIONS } from '../src/permissions.js'
import { makeFakeMemory } from '../src/testing.js'

// The ops each workflow's declared ceiling is expected to permit. Everything
// else must be denied by default — proving default-deny structurally.
const EXPECTED_OPS: Record<MemoryWorkflowId, readonly AgentmemoryOperation[]> = {
  'daily-note': ['recall', 'save'],
  'session-summary': ['recall', 'save'],
  'weekly-archive': ['recall', 'save'],
  consolidation: ['search', 'save'],
  promotion: ['recall', 'save'],
  'stale-prune': ['recall'],
  'search-health': ['search'],
  'integrity-audit': ['recall', 'graph'],
}

describe('declared agentmemory permissions (default-deny)', () => {
  for (const workflow of Object.keys(WORKFLOW_PERMISSIONS) as MemoryWorkflowId[]) {
    const allowed = new Set(EXPECTED_OPS[workflow])

    it(`${workflow}: permits exactly its declared ops`, async () => {
      // sessions() maps to the 'recall' op in the handle, so probe via the
      // raw ops through observable effects: a permitted save reaches the fake,
      // a denied save does not.
      const memory = makeFakeMemory(workflow, {})
      await memory.save({ title: 't', content: 'c' })
      const saveAllowed = (memory as { saved: unknown[] }).saved.length > 0
      expect(saveAllowed).toBe(allowed.has('save'))
    })

    it(`${workflow}: denies every op outside its ceiling`, async () => {
      const memory = makeFakeMemory(workflow, { recall: [], search: {}, graph: {} })
      // Attempt every op; only allowed ops should record a backend call.
      await memory.observe({ sessionId: 's', hookType: 'x', data: {} })
      await memory.smartSearch({ query: 'q' })
      await memory.startSession({ sessionId: 's' })
      await memory.context({ query: 'q' })
      await memory.save({ title: 't', content: 'c' })
      await memory.recall({})
      await memory.graphQuery({ query: 'q' })
      const seen = new Set(
        (memory as { calls: { op: AgentmemoryOperation }[] }).calls.map((c) => c.op),
      )
      for (const op of ALL_AGENTMEMORY_OPS) {
        if (allowed.has(op)) expect(seen.has(op)).toBe(true)
        else expect(seen.has(op)).toBe(false)
      }
    })
  }

  it('read-only workflows cannot save even when explicitly asked', async () => {
    for (const workflow of ['stale-prune', 'search-health', 'integrity-audit'] as const) {
      const memory = makeFakeMemory(workflow, {})
      await memory.save({ title: 't', content: 'c' })
      expect((memory as { saved: unknown[] }).saved.length).toBe(0)
    }
  })
})
