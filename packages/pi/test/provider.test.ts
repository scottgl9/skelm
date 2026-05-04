/**
 * Unit tests for PiProvider and createPiBackend
 */

import { describe, expect, it, vi } from 'vitest'
import {
  PiBackendAuthenticationError,
  PiBackendError,
  PiBackendTimeoutError,
  createPiBackend,
} from '../src/backend.js'
import { createPiProvider } from '../src/provider.js'
import { PiRpcClient } from '../src/rpc-client.js'

// Mock child_process for provider health checks
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('0.73.0'),
    spawn: vi.fn(),
  }
})

// ── createPiBackend ──────────────────────────────────────────────────────────

describe('createPiBackend', () => {
  it('creates a backend with default id', () => {
    const b = createPiBackend()
    expect(b.id).toBe('pi')
  })

  it('accepts custom id and label', () => {
    const b = createPiBackend({ id: 'my-pi', label: 'My Pi' })
    expect(b.id).toBe('my-pi')
    expect(b.label).toBe('My Pi')
  })

  it('reports native toolPermissions', () => {
    expect(createPiBackend().capabilities.toolPermissions).toBe('native')
  })

  it('reports modelSelection:true when model is set', () => {
    expect(createPiBackend({ model: 'qwen36' }).capabilities.modelSelection).toBe(true)
  })

  it('reports modelSelection:false when model is unset', () => {
    expect(createPiBackend().capabilities.modelSelection).toBe(false)
  })

  it('exposes a run() method', () => {
    expect(typeof createPiBackend().run).toBe('function')
  })

  it('does not expose infer() (pi is agent-only)', () => {
    expect(createPiBackend().infer).toBeUndefined()
  })
})

// ── PiRpcClient unit ─────────────────────────────────────────────────────────

describe('PiRpcClient', () => {
  it('constructs without throwing', () => {
    expect(() => new PiRpcClient({ command: 'pi' })).not.toThrow()
  })

  it('throws if prompt() called before start()', async () => {
    const c = new PiRpcClient()
    await expect(c.prompt('hello')).rejects.toThrow('not started')
  })
})

// ── error hierarchy ──────────────────────────────────────────────────────────

describe('error types', () => {
  it('PiBackendError instanceof Error', () => {
    expect(new PiBackendError('x')).toBeInstanceOf(Error)
  })

  it('PiBackendAuthenticationError instanceof PiBackendError', () => {
    expect(new PiBackendAuthenticationError('x')).toBeInstanceOf(PiBackendError)
  })

  it('PiBackendTimeoutError instanceof PiBackendError', () => {
    expect(new PiBackendTimeoutError('x')).toBeInstanceOf(PiBackendError)
  })
})

// ── PiProvider ───────────────────────────────────────────────────────────────

describe('PiProvider', () => {
  it('creates with default config', () => {
    const p = createPiProvider()
    expect(p.id).toBe('pi')
    expect(p.name).toBe('Pi Coding Agent')
  })

  it('reports native toolPermissions', () => {
    expect(createPiProvider().capabilities.toolPermissions).toBe('native')
  })

  it('healthCheck returns healthy when pi is found', async () => {
    const p = createPiProvider()
    const status = await p.healthCheck()
    expect(status.healthy).toBe(true)
  })

  it('healthCheck returns unhealthy when pi is not found', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error('not found')
    })
    const p = createPiProvider()
    const status = await p.healthCheck()
    expect(status.healthy).toBe(false)
  })
})
