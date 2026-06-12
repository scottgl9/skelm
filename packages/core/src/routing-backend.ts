import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  BackendId,
  InferenceRequest,
  InferenceResponse,
  SkelmBackend,
} from './backend.js'

export interface RoutingBackendOptions {
  id: BackendId
  /** First backend to try. */
  primary: SkelmBackend
  /** Tried in order if primary throws an error retryable() considers transient. */
  failover?: readonly SkelmBackend[]
  /**
   * Decide whether an error from a child backend should trigger failover.
   * Returns true → try next backend; false → propagate the error.
   *
   * Default: any thrown Error fails over. Override for stricter rules
   * (e.g., only network errors but not validation errors).
   */
  retryable?: (err: unknown, attempt: { backendId: BackendId; attemptIndex: number }) => boolean
  /**
   * Optional callback fired when a backend errors and the wrapper falls
   * over to the next. Useful for metrics / logging in tests.
   */
  onFailover?: (info: { from: BackendId; to: BackendId; error: unknown }) => void
}

/**
 * Wrap a primary + failover list into a single SkelmBackend that tries each
 * in turn until one succeeds. Mirrors the marktoflow routing backend shape:
 * one logical backend id, multiple physical providers behind it.
 *
 * Security-relevant capabilities are the weakest value across every child.
 * The runner gates once against this wrapper before failover happens, so the
 * wrapper must never advertise a stronger enforcement surface than a failover
 * backend can honor.
 */
export function createRoutingBackend(opts: RoutingBackendOptions): SkelmBackend {
  const all = [opts.primary, ...(opts.failover ?? [])]
  const isRetryable = opts.retryable ?? (() => true)

  const tryEach = async <T>(
    method: 'inference' | 'run',
    fn: (b: SkelmBackend) => Promise<T>,
  ): Promise<T> => {
    let lastErr: unknown
    for (let i = 0; i < all.length; i++) {
      const backend = all[i]
      if (backend === undefined) continue
      if (backend[method] === undefined) {
        // Skip backends that don't implement this method; fall through to
        // the next. Treat as a non-failure so retryable() doesn't see it.
        continue
      }
      try {
        return await fn(backend)
      } catch (err) {
        lastErr = err
        if (i + 1 >= all.length) break
        if (!isRetryable(err, { backendId: backend.id, attemptIndex: i })) break
        const next = all[i + 1]
        if (next === undefined) break
        opts.onFailover?.({ from: backend.id, to: next.id, error: err })
      }
    }
    throw (
      lastErr ?? new Error(`no backend in routing wrapper "${opts.id}" could service the request`)
    )
  }

  const primaryCaps = opts.primary.capabilities
  const allCaps = all.map((b) => b.capabilities)
  const capabilities: BackendCapabilities = {
    prompt: primaryCaps.prompt,
    streaming: primaryCaps.streaming,
    sessionLifecycle: primaryCaps.sessionLifecycle,
    mcp: allCaps.every((caps) => caps.mcp),
    skills: allCaps.every((caps) => caps.skills),
    modelSelection: primaryCaps.modelSelection,
    toolPermissions: weakestToolPermissions(allCaps.map((caps) => caps.toolPermissions)),
    ...(allCaps.some((caps) => caps.vision !== undefined) && {
      vision: allCaps.every((caps) => caps.vision === true),
    }),
    ...(allCaps.some((caps) => caps.agentmemory !== undefined) && {
      agentmemory: allCaps.every((caps) => caps.agentmemory === true),
    }),
  }

  const wrapper: SkelmBackend = {
    id: opts.id,
    capabilities,
    async dispose(): Promise<void> {
      await Promise.all(all.map((b) => b.dispose?.()))
    },
  }

  if (all.some((b) => typeof b.inference === 'function')) {
    wrapper.inference = (req: InferenceRequest, ctx: BackendContext): Promise<InferenceResponse> =>
      tryEach('inference', (b) => {
        if (b.inference === undefined) throw new Error(`backend ${b.id} has no infer`)
        return b.inference(req, ctx)
      })
  }
  if (all.some((b) => typeof b.run === 'function')) {
    wrapper.run = (req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> =>
      tryEach('run', (b) => {
        if (b.run === undefined) throw new Error(`backend ${b.id} has no run`)
        return b.run(req, ctx)
      })
  }
  return wrapper
}

function weakestToolPermissions(
  values: readonly BackendCapabilities['toolPermissions'][],
): BackendCapabilities['toolPermissions'] {
  if (values.includes('unsupported')) return 'unsupported'
  if (values.includes('advisory')) return 'advisory'
  if (values.includes('wrapped')) return 'wrapped'
  return 'native'
}
