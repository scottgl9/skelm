/**
 * Unit tests for PiProvider
 */

import { describe, expect, it, vi } from 'vitest'
import { createPiProvider } from '../src/provider.js'
import { createPiSdkBackend } from '../src/sdk-backend.js'

vi.mock('../src/sdk-backend.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/sdk-backend.js')>('../src/sdk-backend.js')
  return {
    ...actual,
    createPiSdkBackend: vi.fn((options) => ({
      id: options?.id ?? 'pi',
      label: options?.label ?? 'Pi Coding Agent (SDK)',
      capabilities: {
        prompt: true,
        streaming: true,
        sessionLifecycle: true,
        mcp: false,
        skills: true,
        modelSelection: false,
        toolPermissions: 'native',
        vision: options?.vision ?? true,
      },
      inference: vi.fn(),
      run: vi.fn(),
    })),
  }
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

  it('reports SDK capabilities', () => {
    const caps = createPiProvider().capabilities
    expect(caps.prompt).toBe(false)
    expect(caps.skills).toBe(true)
    expect(caps.providerSpecific.vision).toBe(true)
  })

  it('healthCheck returns healthy when the SDK is installed', async () => {
    const p = createPiProvider()
    const status = await p.healthCheck()
    expect(status.healthy).toBe(true)
    expect(status.status).toBe('pi SDK available')
  })

  it('creates an SDK backend with initialized provider options', async () => {
    const p = createPiProvider()
    await p.initialize({
      provider: 'openai',
      model: 'test-model',
      baseUrl: 'http://test.invalid/v1',
      apiKey: 'test-key',
      cwd: '/tmp/project',
      timeout: 1000,
      maxConcurrent: 1,
    })
    await p.createBackend({ id: 'pi' })

    expect(createPiSdkBackend).toHaveBeenCalledWith({
      provider: 'openai',
      model: 'test-model',
      baseUrl: 'http://test.invalid/v1',
      apiKey: 'test-key',
      cwd: '/tmp/project',
      timeout: 1000,
      maxConcurrent: 1,
      id: 'pi',
    })
  })
})
