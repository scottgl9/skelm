import { fileURLToPath } from 'node:url'
import { isPersistentWorkflow } from '@skelm/core'
import { describe, expect, it } from 'vitest'

// Guards the shipped matrix-assistant example: if the persistent-workflow shape
// or the unrestricted opt-in drifts, this fails before the README does.
const EXAMPLE = fileURLToPath(
  new URL('../../../examples/matrix-assistant/assistant.workflow.mts', import.meta.url),
)

describe('examples/matrix-assistant', () => {
  it('exports a persistent workflow with a per-room session key and a queue trigger', async () => {
    const mod = (await import(EXAMPLE)) as { default: unknown }
    const wf = mod.default
    expect(isPersistentWorkflow(wf)).toBe(true)
    if (!isPersistentWorkflow(wf)) return

    expect(wf.id).toBe('matrix-assistant')
    expect(wf.agent.sessionKey({ roomId: '!r:example.org' } as never)).toBe('!r:example.org')
    expect(wf.triggers?.[0]).toMatchObject({ kind: 'queue', sourceId: 'matrix' })
    // Requests the bypass (inert until the config grants the id).
    expect(wf.agent.permissions?.requestUnrestricted).toBe(true)
  })
})
