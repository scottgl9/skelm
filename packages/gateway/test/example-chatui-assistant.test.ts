import { fileURLToPath } from 'node:url'
import { isPersistentWorkflow } from '@skelm/core'
import { describe, expect, it } from 'vitest'

// Guards the shipped chatui-assistant example: if the persistent-workflow shape,
// the two-frontend trigger wiring, or the unrestricted opt-in drifts, this fails
// before the README does.
const EXAMPLE = fileURLToPath(
  new URL('../../../examples/chatui-assistant/chatui-assistant.workflow.mts', import.meta.url),
)

describe('examples/chatui-assistant', () => {
  it('exports a persistent workflow with a per-session key and both chat triggers', async () => {
    const mod = (await import(EXAMPLE)) as { default: unknown }
    const wf = mod.default
    expect(isPersistentWorkflow(wf)).toBe(true)
    if (!isPersistentWorkflow(wf)) return

    expect(wf.id).toBe('chatui-assistant')
    // Minimal shape: no preamble steps, just the chat agent.
    expect(wf.steps).toBeUndefined()
    expect(wf.agent.sessionKey({ sessionId: 's1' } as never)).toBe('s1')
    // Persona lives in AGENTS.md/SOUL.md, loaded relative to the workflow file.
    expect(wf.agent.agentDef).toBe('./agents/assistant')
    // One workflow, two frontends: the terminal (`tui`) and browser (`web`) sources.
    const sourceIds = (wf.triggers ?? []).map((t) => (t as { sourceId?: string }).sourceId)
    expect(sourceIds).toEqual(['tui', 'web'])
    // Requests the bypass (inert until the config grants the id).
    expect(wf.agent.permissions?.requestUnrestricted).toBe(true)
    // Declares the agentmemory ops it relies on for cross-session recall.
    expect(wf.agent.permissions?.agentmemory?.allowRecall).toBe(true)
  })
})
