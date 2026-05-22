import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AcpClient } from '../../src/acp/index.js'

const MOCK_AGENT = fileURLToPath(new URL('./mock-acp-agent.ts', import.meta.url))

describe('AcpClient — against a mock ACP agent', () => {
  it('initialize → newSession → prompt → end_turn', async () => {
    const client = new AcpClient()
    try {
      const init = await client.start({
        command: 'node',
        args: [MOCK_AGENT],
      })
      expect(init.protocolVersion).toBe(1)

      const sid = await client.newSession({ cwd: process.cwd() })
      expect(sid).toMatch(/^session-/)

      const result = await client.prompt({ text: 'hello' })
      expect(result.stopReason).toBe('end_turn')
      expect(result.text).toBe('echo:hello')
      expect(result.updates.length).toBe(2)
    } finally {
      await client.stop()
    }
  })

  it('captures every session/update via the onUpdate callback', async () => {
    const client = new AcpClient()
    const observed: string[] = []
    try {
      await client.start({ command: 'node', args: [MOCK_AGENT] })
      await client.newSession({ cwd: process.cwd() })
      await client.prompt({
        text: 'world',
        onUpdate: (u) => observed.push(u.sessionUpdate),
      })
      expect(observed).toEqual(['agent_message_chunk', 'agent_message_chunk'])
    } finally {
      await client.stop()
    }
  })

  it('supports agents that emit newline-delimited JSON', async () => {
    const client = new AcpClient()
    try {
      const init = await client.start({
        command: 'node',
        args: [MOCK_AGENT],
        env: { SKELM_ACP_MOCK_OUTPUT: 'jsonl' },
      })
      expect(init.protocolVersion).toBe(1)

      const sid = await client.newSession({ cwd: process.cwd() })
      expect(sid).toMatch(/^session-/)

      const result = await client.prompt({ text: 'hello' })
      expect(result.stopReason).toBe('end_turn')
      expect(result.text).toBe('echo:hello')
      expect(result.updates.length).toBe(2)
    } finally {
      await client.stop()
    }
  })

  it('throws when prompt is called before newSession', async () => {
    const client = new AcpClient()
    try {
      await client.start({ command: 'node', args: [MOCK_AGENT] })
      await expect(() => client.prompt({ text: 'x' })).rejects.toThrow(/session not started/)
    } finally {
      await client.stop()
    }
  })
})
