import { fileURLToPath } from 'node:url'
import { isPersistentWorkflow } from '@skelm/core'
import { describe, expect, it } from 'vitest'

// Guards the shipped telegram-assistant example: if the persistent-workflow shape
// or the unrestricted opt-in drifts, this fails before the README does.
const EXAMPLE = fileURLToPath(
  new URL('../../../examples/telegram-assistant/assistant.workflow.mts', import.meta.url),
)

describe('examples/telegram-assistant', () => {
  it('exports a persistent workflow with a preamble step, per-chat session key, and queue trigger', async () => {
    const mod = (await import(EXAMPLE)) as { default: unknown }
    const wf = mod.default
    expect(isPersistentWorkflow(wf)).toBe(true)
    if (!isPersistentWorkflow(wf)) return

    expect(wf.id).toBe('telegram-assistant')
    expect(wf.steps?.[0]?.id).toBe('prepare')
    expect(wf.agent.sessionKey({ chatId: 'c1' } as never)).toBe('c1')
    // Persona lives in AGENTS.md/SOUL.md, loaded relative to the workflow file.
    expect(wf.agent.agentDef).toBe('./agents/assistant')
    expect(wf.triggers?.[0]).toMatchObject({ kind: 'queue', sourceId: 'telegram' })
    // Requests the bypass (inert until the config grants the id).
    expect(wf.agent.permissions?.requestUnrestricted).toBe(true)
  })
})
