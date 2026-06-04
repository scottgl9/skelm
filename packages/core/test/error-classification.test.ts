import { describe, expect, it } from 'vitest'
import { AgentRegistry, executeAgentStep } from '../src/agent-provider.js'
import { agent } from '../src/builders.js'
import {
  AgentProviderNotFoundError,
  BackendRegistry,
  ConfigError,
  RegistryError,
  serializeError,
  toErrorMessage,
} from '../src/index.js'
import { fixtureBackend } from '../src/testing/contract.js'

describe('error classification', () => {
  it('serializes non-Error thrown values with a stable message', () => {
    expect(serializeError('plain')).toEqual({ name: 'NonError', message: 'plain' })
    expect(serializeError({ code: 'boom' })).toEqual({
      name: 'NonError',
      message: '{"code":"boom"}',
    })
    expect(toErrorMessage(undefined)).toBe('undefined')
  })

  it('uses RegistryError for duplicate backend ids', () => {
    const reg = new BackendRegistry()
    reg.register(fixtureBackend({ id: 'same', respond: () => ({ text: 'ok' }) }))
    expect(() =>
      reg.register(fixtureBackend({ id: 'same', respond: () => ({ text: 'other' }) })),
    ).toThrow(RegistryError)
  })

  it('uses typed agent-provider lookup errors on the legacy registry path', async () => {
    const step = agent({ id: 'a', prompt: 'hi' })
    await expect(
      executeAgentStep(step, { input: undefined, steps: {} }, new AgentRegistry()),
    ).rejects.toBeInstanceOf(AgentProviderNotFoundError)
  })

  it('exposes ConfigError as a public catch target', () => {
    const err = new ConfigError('bad config', 'test')
    expect(err.name).toBe('ConfigError')
    expect(err.scope).toBe('test')
  })
})
