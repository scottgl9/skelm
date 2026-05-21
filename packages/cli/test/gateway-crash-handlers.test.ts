import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCrashHandlersForTest, installCrashHandlers } from '../src/gateway.js'
import type { MainIO } from '../src/main.js'

// AGENTS.md invariant: the gateway main loop must not produce an unhandled
// rejection or uncaught exception. installCrashHandlers is the last-line
// backstop — verify it logs, drains the gateway, and exits non-zero for both
// rejection and exception channels.

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

function buildIo(): { io: MainIO; stderr: Capture; stdout: Capture } {
  const stderr = new Capture()
  const stdout = new Capture()
  return { io: { stdout, stderr, stdin: process.stdin }, stderr, stdout }
}

describe('installCrashHandlers', () => {
  beforeEach(() => {
    __resetCrashHandlersForTest()
  })
  afterEach(() => {
    __resetCrashHandlersForTest()
  })

  it('drains the gateway and exits 1 on unhandledRejection', async () => {
    const { io, stderr } = buildIo()
    const stop = vi.fn().mockResolvedValue(undefined)
    const exit = vi.fn()
    installCrashHandlers({ stop }, io, exit)
    process.emit('unhandledRejection', new Error('boom'), Promise.resolve())
    // Allow the stop().finally() microtask chain to settle.
    await new Promise((r) => setImmediate(r))
    expect(stop).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr.text()).toMatch(/gateway unhandledRejection: boom/)
  })

  it('drains the gateway and exits 1 on uncaughtException', async () => {
    const { io, stderr } = buildIo()
    const stop = vi.fn().mockResolvedValue(undefined)
    const exit = vi.fn()
    installCrashHandlers({ stop }, io, exit)
    process.emit('uncaughtException', new Error('kaboom'))
    await new Promise((r) => setImmediate(r))
    expect(stop).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr.text()).toMatch(/gateway uncaughtException: kaboom/)
  })

  it('still exits 1 when gateway.stop() rejects', async () => {
    const { io, stderr } = buildIo()
    const stop = vi.fn().mockRejectedValue(new Error('stop failed'))
    const exit = vi.fn()
    installCrashHandlers({ stop }, io, exit)
    process.emit('unhandledRejection', 'string-reason', Promise.resolve())
    await new Promise((r) => setImmediate(r))
    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr.text()).toMatch(/gateway stop failed.*stop failed/)
  })

  it('installs only once even when called repeatedly', () => {
    const { io } = buildIo()
    const stop = vi.fn().mockResolvedValue(undefined)
    const exit = vi.fn()
    installCrashHandlers({ stop }, io, exit)
    const after = process.listenerCount('unhandledRejection')
    installCrashHandlers({ stop }, io, exit)
    installCrashHandlers({ stop }, io, exit)
    expect(process.listenerCount('unhandledRejection')).toBe(after)
  })
})
