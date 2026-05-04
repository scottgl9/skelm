import { describe, expect, it } from 'vitest'
import { CodingAgentManager } from '../src/index.js'

describe('CodingAgentManager — resident', () => {
  it('records a fixed-url resident handle without spawning', async () => {
    const m = new CodingAgentManager()
    const h = await m.startResident({
      id: 'remote-pi',
      runtime: 'pi',
      lifecycle: 'resident',
      url: 'http://localhost:9999',
    })
    expect(h.status).toBe('running')
    expect(h.url).toBe('http://localhost:9999')
    expect(h.process).toBeUndefined()
    await m.stopAll()
  })

  it('spawns a resident with a free port and substitutes ${PORT} in args', async () => {
    const m = new CodingAgentManager()
    // Use `sleep` as a stand-in for `opencode serve` — proves the spawn path
    // and port allocation; the agent doesn't actually need to listen.
    const h = await m.startResident({
      id: 'fake-serve',
      runtime: 'opencode',
      lifecycle: 'resident',
      command: 'sleep',
      args: ['1'],
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(h.status).toBe('running')
    expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(typeof h.pid).toBe('number')
    await m.stopAll()
  })

  it('throws if a resident has neither url nor command', async () => {
    const m = new CodingAgentManager()
    await expect(
      m.startResident({ id: 'bad', runtime: 'opencode', lifecycle: 'resident' }),
    ).rejects.toThrow(/url or command/)
  })
})

describe('CodingAgentManager — ephemeral', () => {
  it('spawns a one-shot agent and captures stdout/stderr/exit', async () => {
    const m = new CodingAgentManager()
    const result = await m.spawnEphemeral(
      {
        id: 'echo',
        runtime: 'shell',
        lifecycle: 'ephemeral',
        command: 'sh',
        args: ['-c', 'cat; echo done'],
      },
      { stdin: 'hello\n' },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
    expect(result.stdout).toContain('done')
  })

  it('rejects when concurrency cap is exceeded', async () => {
    const m = new CodingAgentManager({ ephemeralConcurrency: 1 })
    const slow = m.spawnEphemeral(
      { id: 'slow', runtime: 'shell', lifecycle: 'ephemeral', command: 'sleep', args: ['0.2'] },
      {},
    )
    await new Promise((r) => setTimeout(r, 20))
    await expect(
      m.spawnEphemeral(
        { id: 'slow', runtime: 'shell', lifecycle: 'ephemeral', command: 'sleep', args: ['0.2'] },
        {},
      ),
    ).rejects.toThrow(/concurrency cap/)
    await slow
  })

  it('refuses to spawn a resident agent ephemerally', async () => {
    const m = new CodingAgentManager()
    await expect(
      m.spawnEphemeral(
        { id: 'r', runtime: 'opencode', lifecycle: 'resident', command: 'true' },
        {},
      ),
    ).rejects.toThrow(/not ephemeral/)
  })
})
