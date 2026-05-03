// Integration tests against real ACP-speaking CLIs.
//
// These are skipped by default. Enable with:
//
//   SKELM_ACP_INTEGRATION=copilot pnpm test
//   SKELM_ACP_INTEGRATION=claude   pnpm test
//
// Requires the corresponding CLI to be installed and authenticated.
// CI does not run these.

import { describe, expect, it } from 'vitest'
import { AcpClient } from '../../src/acp/index.js'

const target = process.env.SKELM_ACP_INTEGRATION
const skip = target !== 'copilot' && target !== 'claude'
const describeMaybe = skip ? describe.skip : describe

describeMaybe(`AcpClient — real ${target ?? 'cli'} ACP server`, () => {
  it('completes an initialize → session → prompt round-trip', async () => {
    const client = new AcpClient()
    try {
      const init = await client.start(spawnFor(target))
      expect(init.protocolVersion).toBeGreaterThanOrEqual(1)
      const sessionId = await client.newSession({ cwd: process.cwd() })
      expect(sessionId.length).toBeGreaterThan(0)

      const result = await client.prompt({ text: 'Reply with exactly one word: ok' })
      expect(result.stopReason).toBe('end_turn')
      expect(result.text.trim().length).toBeGreaterThan(0)
      expect(result.updates.length).toBeGreaterThan(0)
    } finally {
      await client.stop()
    }
  }, 60_000)
})

function spawnFor(name: string | undefined): { command: string; args: readonly string[] } {
  switch (name) {
    case 'copilot':
      return { command: 'copilot', args: ['--acp'] }
    case 'claude':
      return { command: 'claude-code-acp', args: [] }
    default:
      throw new Error(`unsupported integration target: ${name}`)
  }
}
