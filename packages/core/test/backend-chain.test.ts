import { describe, expect, it } from 'vitest'
import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  BackendCapabilityError,
  type BackendContext,
  BackendNotFoundError,
  BackendRegistry,
  type InferenceRequest,
  type InferenceResponse,
  type SkelmBackend,
} from '../src/backend.js'
import type { BackendChainExhaustedError } from '../src/errors.js'
import { createStepFallbackBackend, resolveBackendForStep } from '../src/execution/backend-chain.js'

const baseCaps: BackendCapabilities = {
  prompt: true,
  streaming: false,
  sessionLifecycle: false,
  mcp: false,
  skills: false,
  modelSelection: true,
  toolPermissions: 'unsupported',
}

function stub(opts: {
  id: string
  caps?: Partial<BackendCapabilities>
  infer?: (req: InferenceRequest, ctx: BackendContext) => Promise<InferenceResponse>
  run?: (req: AgentRequest, ctx: BackendContext) => Promise<AgentResponse>
}): SkelmBackend {
  const b: SkelmBackend = { id: opts.id, capabilities: { ...baseCaps, ...opts.caps } }
  if (opts.infer) b.inference = opts.infer
  if (opts.run) b.run = opts.run
  return b
}

const ctx: BackendContext = { signal: new AbortController().signal }

function registry(...backends: SkelmBackend[]): BackendRegistry {
  const reg = new BackendRegistry()
  for (const b of backends) reg.register(b)
  return reg
}

describe('resolveBackendForStep', () => {
  it('resolves a single id unchanged (no wrapper)', () => {
    const a = stub({ id: 'a', infer: async () => ({ text: 'x' }) })
    const reg = registry(a)
    expect(resolveBackendForStep(reg, 's', 'a', 'llm')).toBe(a)
  })

  it('resolves undefined to the first capable backend', () => {
    const a = stub({ id: 'a', run: async () => ({ text: 'x' }) })
    const reg = registry(a)
    expect(resolveBackendForStep(reg, 's', undefined, 'agent')).toBe(a)
  })

  it('a single-element array resolves to that backend (not a wrapper)', () => {
    const a = stub({ id: 'a', run: async () => ({ text: 'x' }) })
    const reg = registry(a)
    expect(resolveBackendForStep(reg, 's', ['a'], 'agent')).toBe(a)
  })

  it('rejects an empty backend chain', () => {
    const reg = registry(stub({ id: 'a', run: async () => ({ text: 'x' }) }))
    expect(() => resolveBackendForStep(reg, 's', [], 'agent')).toThrow(BackendNotFoundError)
  })

  it('surfaces an unregistered id in a chain', () => {
    const a = stub({ id: 'a', run: async () => ({ text: 'x' }) })
    const reg = registry(a)
    expect(() => resolveBackendForStep(reg, 's', ['a', 'missing'], 'agent')).toThrow(
      BackendNotFoundError,
    )
  })

  it('validates per-member capability (agent member without run)', () => {
    const a = stub({ id: 'a', run: async () => ({ text: 'x' }) })
    const b = stub({ id: 'b', infer: async () => ({ text: 'y' }) }) // no run
    const reg = registry(a, b)
    expect(() => resolveBackendForStep(reg, 's', ['a', 'b'], 'agent')).toThrow(
      BackendCapabilityError,
    )
  })
})

describe('createStepFallbackBackend', () => {
  it('falls over to the next backend on error (run)', async () => {
    let bCalls = 0
    const a = stub({
      id: 'a',
      run: async () => {
        throw new Error('a down')
      },
    })
    const b = stub({
      id: 'b',
      run: async () => {
        bCalls++
        return { text: 'from-b' }
      },
    })
    const chain = createStepFallbackBackend('s', [a, b])
    const out = await chain.run?.({ prompt: 'hi' } as AgentRequest, ctx)
    expect(out?.text).toBe('from-b')
    expect(bCalls).toBe(1)
  })

  it('uses the first backend when it succeeds (no fallover)', async () => {
    let bCalls = 0
    const a = stub({ id: 'a', infer: async () => ({ text: 'from-a' }) })
    const b = stub({
      id: 'b',
      infer: async () => {
        bCalls++
        return { text: 'from-b' }
      },
    })
    const chain = createStepFallbackBackend('s', [a, b])
    const out = await chain.inference?.({ messages: [] }, ctx)
    expect(out?.text).toBe('from-a')
    expect(bCalls).toBe(0)
  })

  it('throws BackendChainExhaustedError with ordered attempts when all fail', async () => {
    const a = stub({
      id: 'a',
      run: async () => {
        throw new Error('a down')
      },
    })
    const b = stub({
      id: 'b',
      run: async () => {
        throw new Error('b down')
      },
    })
    const chain = createStepFallbackBackend('my-step', [a, b])
    await expect(chain.run?.({ prompt: 'hi' } as AgentRequest, ctx)).rejects.toMatchObject({
      name: 'BackendChainExhaustedError',
      stepId: 'my-step',
    })
    const err = await chain
      .run?.({ prompt: 'hi' } as AgentRequest, ctx)
      .catch((e: unknown) => e as BackendChainExhaustedError)
    expect(err?.attempts.map((a) => a.backendId)).toEqual(['a', 'b'])
  })

  it('takes capabilities from the first member', () => {
    const a = stub({ id: 'a', caps: { vision: true }, run: async () => ({ text: 'x' }) })
    const b = stub({ id: 'b', caps: { vision: true }, run: async () => ({ text: 'y' }) })
    const chain = createStepFallbackBackend('s', [a, b])
    expect(chain.capabilities.vision).toBe(true)
    expect(chain.id).toBe('a+b')
  })

  it('rejects a capability-heterogeneous chain at construction (fail closed)', () => {
    // a enforces tool permissions natively; b cannot — falling over to b would
    // silently drop enforcement the step's gate already cleared against a.
    const a = stub({
      id: 'a',
      caps: { toolPermissions: 'native' },
      run: async () => ({ text: 'x' }),
    })
    const b = stub({
      id: 'b',
      caps: { toolPermissions: 'unsupported' },
      run: async () => ({ text: 'y' }),
    })
    expect(() => createStepFallbackBackend('s', [a, b])).toThrow(BackendCapabilityError)
    expect(() => createStepFallbackBackend('s', [a, b])).toThrow(/capability-homogeneous/)
  })

  it('rejects a chain whose members differ on vision', () => {
    const a = stub({ id: 'a', caps: { vision: true }, run: async () => ({ text: 'x' }) })
    const b = stub({ id: 'b', caps: { vision: false }, run: async () => ({ text: 'y' }) })
    expect(() => createStepFallbackBackend('s', [a, b])).toThrow(/differ on capability "vision"/)
  })
})
