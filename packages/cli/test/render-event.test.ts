import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { renderEvent } from '../src/run.js'

class Capture extends Writable {
  chunks: string[] = []
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(chunk.toString('utf8'))
    cb()
  }
  text(): string {
    return this.chunks.join('')
  }
}

function mkIo(): { stdout: Capture; stderr: Capture; stdin: Readable } {
  return { stdout: new Capture(), stderr: new Capture(), stdin: Readable.from([]) }
}

describe('renderEvent — step.partial', () => {
  it('writes delta to stderr in human mode', () => {
    const io = mkIo()
    renderEvent(
      {
        event: 'message',
        id: undefined,
        data: { type: 'step.partial', stepId: 'agent', delta: 'hello ' },
        raw: '',
      },
      'human',
      io,
    )
    renderEvent(
      {
        event: 'message',
        id: undefined,
        data: { type: 'step.partial', stepId: 'agent', delta: 'world' },
        raw: '',
      },
      'human',
      io,
    )
    expect(io.stderr.text()).toBe('hello world')
  })

  it('skips empty deltas', () => {
    const io = mkIo()
    renderEvent(
      {
        event: 'message',
        id: undefined,
        data: { type: 'step.partial', stepId: 'agent', delta: '' },
        raw: '',
      },
      'human',
      io,
    )
    expect(io.stderr.text()).toBe('')
  })

  it('in json mode emits the full payload (one JSON line)', () => {
    const io = mkIo()
    renderEvent(
      {
        event: 'message',
        id: undefined,
        data: { type: 'step.partial', stepId: 'agent', delta: 'tok' },
        raw: '',
      },
      'json',
      io,
    )
    const lines = io.stderr.text().trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] as string)
    expect(parsed.type).toBe('step.partial')
    expect(parsed.delta).toBe('tok')
  })

  it('in none mode emits nothing', () => {
    const io = mkIo()
    renderEvent(
      {
        event: 'message',
        id: undefined,
        data: { type: 'step.partial', stepId: 'agent', delta: 'tok' },
        raw: '',
      },
      'none',
      io,
    )
    expect(io.stderr.text()).toBe('')
  })
})
