import { describe, expect, it } from 'vitest'
import { McpServerManager } from '../src/index.js'

describe('McpServerManager', () => {
  it('records http/sse entries as URL handles without spawning', async () => {
    const m = new McpServerManager()
    await m.startAll([
      { id: 'a', transport: 'http', url: 'http://localhost:9000' },
      { id: 'b', transport: 'sse', url: 'http://localhost:9001/sse' },
    ])
    const a = m.get('a')
    const b = m.get('b')
    expect(a?.status).toBe('running')
    expect(a?.url).toBe('http://localhost:9000')
    expect(a?.process).toBeUndefined()
    expect(b?.transport).toBe('sse')
    await m.stopAll()
  })

  it('spawns a stdio entry and reaches running state', async () => {
    const m = new McpServerManager()
    await m.start({ id: 'sleep', transport: 'stdio', command: 'sleep', args: ['1'] })
    // Wait for spawn event
    await new Promise((r) => setTimeout(r, 100))
    const handle = m.get('sleep')
    expect(handle?.status).toBe('running')
    expect(typeof handle?.pid).toBe('number')
    await m.stopAll()
  })

  it('rejects stdio entry without command', async () => {
    const m = new McpServerManager()
    await expect(m.start({ id: 'bad', transport: 'stdio' })).rejects.toThrow(/requires command/)
  })

  it('restarts on crash up to maxRestarts then gives up', async () => {
    const m = new McpServerManager({ backoffMs: [10, 10, 10], maxRestarts: 2 })
    await m.start({ id: 'crash', transport: 'stdio', command: 'false' })
    // Wait long enough for the initial exit + 2 restart attempts to all complete
    await new Promise((r) => setTimeout(r, 200))
    const handle = m.get('crash')
    expect(handle?.status).toBe('crashed')
    expect(handle?.restarts).toBeGreaterThanOrEqual(2)
    await m.stopAll()
  })
})
