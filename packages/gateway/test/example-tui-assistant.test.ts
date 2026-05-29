import { fileURLToPath } from 'node:url'
import { isPersistentWorkflow } from '@skelm/core'
import { describe, expect, it } from 'vitest'

// Guards the shipped tui-assistant example: if the persistent-workflow shape or
// the unrestricted opt-in drifts, this fails before the README does.
const EXAMPLE = fileURLToPath(
  new URL('../../../examples/tui-assistant/tui-assistant.workflow.mts', import.meta.url),
)

describe('examples/tui-assistant', () => {
  it('exports a persistent workflow with a per-session session key and a queue trigger', async () => {
    const mod = (await import(EXAMPLE)) as { default: unknown }
    const wf = mod.default
    expect(isPersistentWorkflow(wf)).toBe(true)
    if (!isPersistentWorkflow(wf)) return

    expect(wf.id).toBe('tui-assistant')
    // Minimal shape: no preamble steps, just the terminal agent.
    expect(wf.steps).toBeUndefined()
    expect(wf.agent.sessionKey({ sessionId: 's1' } as never)).toBe('s1')
    expect(wf.triggers?.[0]).toMatchObject({ kind: 'queue', sourceId: 'tui' })
    // Requests the bypass (inert until the config grants the id).
    expect(wf.agent.permissions?.requestUnrestricted).toBe(true)
    // Declares the agentmemory ops it relies on for cross-session recall.
    expect(wf.agent.permissions?.agentmemory?.allowRecall).toBe(true)
  })
})
