import { fileURLToPath } from 'node:url'
import { isPersistentAgent } from '@skelm/core'
import { describe, expect, it } from 'vitest'

// Guards the shipped telegram-assistant example: if the persistent-agent shape
// or the unrestricted opt-in drifts, this fails before the README does.
const EXAMPLE = fileURLToPath(
  new URL('../../../examples/telegram-assistant/assistant.workflow.mts', import.meta.url),
)

describe('examples/telegram-assistant', () => {
  it('exports a persistent agent with a per-chat session key and a queue trigger', async () => {
    const mod = (await import(EXAMPLE)) as { default: unknown }
    const agent = mod.default
    expect(isPersistentAgent(agent)).toBe(true)
    if (!isPersistentAgent(agent)) return

    expect(agent.id).toBe('telegram-assistant')
    expect(agent.sessionKey({ chatId: 'c1' } as never)).toBe('c1')
    expect(agent.triggers?.[0]).toMatchObject({ kind: 'queue', sourceId: 'telegram' })
    // Requests the bypass (inert until the config grants the id).
    expect(agent.permissions?.requestUnrestricted).toBe(true)
  })
})
