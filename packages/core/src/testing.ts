// Testing helpers exported from `@skelm/core/testing`. These are public:
// customers writing workflow tests use them, plugin authors use them when
// running the contract suite.

import type {
  BackendCapabilities,
  BackendContext,
  InferRequest,
  InferResponse,
  SkelmBackend,
} from './backend.js'

/**
 * Build a deterministic fixture backend for tests. Provide a map keyed
 * either by step id or by an arbitrary route; the backend's `infer()` calls
 * `respond(req)` and returns the result. Recorded calls are exposed as
 * `calls` for assertions.
 */
export function fixtureBackend(opts: {
  id: string
  label?: string
  capabilities?: Partial<BackendCapabilities>
  respond: (req: InferRequest) => InferResponse | Promise<InferResponse>
}): SkelmBackend & { readonly calls: ReadonlyArray<InferRequest> } {
  const calls: InferRequest[] = []

  const capabilities: BackendCapabilities = {
    prompt: true,
    streaming: false,
    sessionLifecycle: false,
    mcp: false,
    skills: false,
    modelSelection: true,
    toolPermissions: 'unsupported',
    ...opts.capabilities,
  }

  const backend: SkelmBackend & { calls: InferRequest[] } = {
    id: opts.id,
    capabilities,
    calls,
    async infer(req: InferRequest, _ctx: BackendContext): Promise<InferResponse> {
      calls.push(req)
      return opts.respond(req)
    },
  }
  if (opts.label !== undefined) {
    Object.assign(backend, { label: opts.label })
  }
  return backend
}
