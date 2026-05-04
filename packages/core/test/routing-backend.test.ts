import { describe, expect, it } from 'vitest'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  InferRequest,
  InferResponse,
  SkelmBackend,
} from '../src/backend.js'
import { createRoutingBackend } from '../src/routing-backend.js'

const baseCaps: BackendCapabilities = {
  prompt: true,
  streaming: false,
  sessionLifecycle: false,
  mcp: false,
  skills: false,
  modelSelection: true,
  toolPermissions: 'unsupported',
}

function stubBackend(opts: {
  id: string
  inferImpl?: (req: InferRequest, ctx: BackendContext) => Promise<InferResponse>
  runImpl?: (req: AgentRequest, ctx: BackendContext) => Promise<AgentResponse>
}): SkelmBackend {
  const b: SkelmBackend = { id: opts.id, capabilities: baseCaps }
  if (opts.inferImpl) b.infer = opts.inferImpl
  if (opts.runImpl) b.run = opts.runImpl
  return b
}

const dummyCtx: BackendContext = { signal: new AbortController().signal }

describe('createRoutingBackend', () => {
  it('uses the primary when it succeeds; failover never invoked', async () => {
    let primaryCalls = 0
    let fallbackCalls = 0
    const primary = stubBackend({
      id: 'p',
      inferImpl: async () => {
        primaryCalls++
        return { text: 'ok-primary' }
      },
    })
    const fallback = stubBackend({
      id: 'f',
      inferImpl: async () => {
        fallbackCalls++
        return { text: 'ok-fallback' }
      },
    })
    const router = createRoutingBackend({ id: 'r', primary, failover: [fallback] })
    const out = await router.infer?.({ messages: [] }, dummyCtx)
    expect(out?.text).toBe('ok-primary')
    expect(primaryCalls).toBe(1)
    expect(fallbackCalls).toBe(0)
  })

  it('falls over to the next backend when the primary throws', async () => {
    const events: string[] = []
    const primary = stubBackend({
      id: 'p',
      inferImpl: async () => {
        throw new Error('primary down')
      },
    })
    const secondary = stubBackend({
      id: 's',
      inferImpl: async () => ({ text: 'from-secondary' }),
    })
    const router = createRoutingBackend({
      id: 'r',
      primary,
      failover: [secondary],
      onFailover: (info) =>
        events.push(`${info.from}->${info.to}:${(info.error as Error).message}`),
    })
    const out = await router.infer?.({ messages: [] }, dummyCtx)
    expect(out?.text).toBe('from-secondary')
    expect(events).toEqual(['p->s:primary down'])
  })

  it('honors retryable() to skip failover for non-transient errors', async () => {
    const primary = stubBackend({
      id: 'p',
      inferImpl: async () => {
        throw new Error('schema mismatch')
      },
    })
    const secondary = stubBackend({
      id: 's',
      inferImpl: async () => ({ text: 'unreachable' }),
    })
    const router = createRoutingBackend({
      id: 'r',
      primary,
      failover: [secondary],
      retryable: (err) => !(err instanceof Error) || !err.message.includes('schema'),
    })
    await expect(router.infer?.({ messages: [] }, dummyCtx)).rejects.toThrow('schema mismatch')
  })

  it('skips backends that do not implement the requested method', async () => {
    const noInfer = stubBackend({
      id: 'agent-only',
      runImpl: async () => ({ messages: [] }),
    })
    const inferer = stubBackend({
      id: 'inf',
      inferImpl: async () => ({ text: 'ok' }),
    })
    const router = createRoutingBackend({ id: 'r', primary: noInfer, failover: [inferer] })
    const out = await router.infer?.({ messages: [] }, dummyCtx)
    expect(out?.text).toBe('ok')
  })

  it('throws the last error when every backend fails', async () => {
    const a = stubBackend({
      id: 'a',
      inferImpl: async () => {
        throw new Error('a-err')
      },
    })
    const b = stubBackend({
      id: 'b',
      inferImpl: async () => {
        throw new Error('b-err')
      },
    })
    const router = createRoutingBackend({ id: 'r', primary: a, failover: [b] })
    await expect(router.infer?.({ messages: [] }, dummyCtx)).rejects.toThrow('b-err')
  })

  it('forwards capabilities from the primary', () => {
    const primary = stubBackend({ id: 'p', inferImpl: async () => ({ text: '' }) })
    const router = createRoutingBackend({ id: 'r', primary })
    expect(router.capabilities).toEqual(baseCaps)
  })

  it('dispose tears down every child backend', async () => {
    const torn: string[] = []
    const make = (id: string): SkelmBackend => ({
      id,
      capabilities: baseCaps,
      async infer(): Promise<InferResponse> {
        return { text: id }
      },
      async dispose(): Promise<void> {
        torn.push(id)
      },
    })
    const router = createRoutingBackend({
      id: 'r',
      primary: make('a'),
      failover: [make('b'), make('c')],
    })
    await router.dispose?.()
    expect(torn.sort()).toEqual(['a', 'b', 'c'])
  })
})
