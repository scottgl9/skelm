import { fileURLToPath } from 'node:url'
import { isPersistentAgent } from '@skelm/core'
import { describe, expect, it } from 'vitest'

// Guards the shipped tui-assistant example: if the persistent-agent shape or the
// unrestricted opt-in drifts, this fails before the README does.
const EXAMPLE = fileURLToPath(
  new URL('../../../examples/tui-assistant/tui-assistant.workflow.mts', import.meta.url),
)

describe('examples/tui-assistant', () => {
  it('exports a persistent agent with a per-session session key and a queue trigger', async () => {
    const mod = (await import(EXAMPLE)) as { default: unknown }
    const agent = mod.default
    expect(isPersistentAgent(agent)).toBe(true)
    if (!isPersistentAgent(agent)) return

    expect(agent.id).toBe('tui-assistant')
    expect(agent.sessionKey({ sessionId: 's1' } as never)).toBe('s1')
    expect(agent.triggers?.[0]).toMatchObject({ kind: 'queue', sourceId: 'tui' })
    // Requests the bypass (inert until the config grants the id).
    expect(agent.permissions?.requestUnrestricted).toBe(true)
    // Declares the agentmemory ops it relies on for cross-session recall.
    expect(agent.permissions?.agentmemory?.allowRecall).toBe(true)
  })
})
