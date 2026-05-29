// Backend contract suite (vitest-driven). Lives at @skelm/core/testing/contract
// so the rest of @skelm/core/testing can be loaded by `skelm run` workflows
// without dragging vitest's worker-state init into their module graph.

import { describe, expect, it } from 'vitest'
import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  BackendCapabilityError,
  type BackendContext,
  BackendRegistry,
  type InferRequest,
  type InferResponse,
  type SkelmBackend,
  type Usage,
} from '../backend.js'
import { agent, pipeline } from '../builders.js'
import { runPipeline } from '../runner.js'

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

export type BackendContractSuite = 'infer' | 'agent' | 'permission-gate'

export interface BackendContractCase<TRequest, TResponse> {
  readonly name: string
  readonly request: TRequest
  readonly context?: Partial<BackendContext>
  readonly assert?: (response: TResponse) => void | Promise<void>
}

/**
 * Per-dimension adversarial case: the backend's `run()` MUST reject the
 * supplied request because the resolved policy denies the operation the
 * request implies. The suite passes the request through `run()` and asserts
 * either:
 *
 *   - the call throws an Error whose `name` matches `expectedErrorName`
 *     (default `'PermissionDeniedError'`), OR
 *   - the user-provided `assertRejection` matcher accepts the thrown error.
 *
 * Why this exists: per-backend permission mappers (codex, opencode, pi)
 * silently invert booleans or miss dimensions, and unit-testing the
 * mapper in isolation does not prove the live `run()` path actually
 * denies. This block runs the real `run()` and proves the deny path
 * fires end-to-end. Every dimension a backend claims to enforce should
 * have at least one adversarial case here.
 */
export interface BackendAdversarialCase {
  readonly name: string
  readonly dimension: string
  readonly request: AgentRequest
  readonly context?: Partial<BackendContext>
  readonly expectedErrorName?: string
  readonly assertRejection?: (error: unknown) => void | Promise<void>
}

export interface BackendContractOptions {
  readonly name?: string
  readonly skip?: readonly BackendContractSuite[]
  readonly inferCases?: readonly BackendContractCase<InferRequest, InferResponse>[]
  readonly agentCases?: readonly BackendContractCase<AgentRequest, AgentResponse>[]
  readonly adversarialCases?: readonly BackendAdversarialCase[]
}

export function runBackendContract(
  backendOrFactory: SkelmBackend | (() => SkelmBackend | Promise<SkelmBackend>),
  options: BackendContractOptions = {},
): void {
  const name =
    options.name ?? (typeof backendOrFactory === 'function' ? 'backend' : backendOrFactory.id)
  const skipped = new Set(options.skip ?? [])

  describe(`${name} backend contract`, () => {
    it('reports capabilities consistent with its implemented methods', async () => {
      await withBackend(backendOrFactory, async (backend) => {
        expect(backend.id.length).toBeGreaterThan(0)
        if (backend.capabilities.prompt) {
          expect(typeof backend.infer).toBe('function')
        } else {
          expect(backend.infer).toBeUndefined()
        }
        expect(['native', 'wrapped', 'unsupported']).toContain(backend.capabilities.toolPermissions)
      })
    })

    if (!skipped.has('infer')) {
      const inferCases = options.inferCases ?? [
        { name: 'basic infer', request: basicInferRequest() },
      ]
      for (const inferCase of inferCases) {
        it(`satisfies infer case: ${inferCase.name}`, async () => {
          await withBackend(backendOrFactory, async (backend) => {
            if (!backend.capabilities.prompt || typeof backend.infer !== 'function') {
              throw new Error(`backend ${backend.id} does not satisfy the infer contract`)
            }
            const response = await backend.infer(inferCase.request, buildContext(inferCase.context))
            assertInferResponseShape(response, inferCase.request)
            await inferCase.assert?.(response)
          })
        })
      }
    }

    if (!skipped.has('agent')) {
      const agentCases = options.agentCases ?? [
        { name: 'basic agent run', request: basicAgentRequest() },
      ]
      for (const agentCase of agentCases) {
        it(`satisfies agent case: ${agentCase.name}`, async () => {
          await withBackend(backendOrFactory, async (backend) => {
            if (typeof backend.run !== 'function') {
              throw new Error(`backend ${backend.id} does not satisfy the agent contract`)
            }
            const response = await backend.run(agentCase.request, buildContext(agentCase.context))
            assertAgentResponseShape(response, agentCase.request)
            await agentCase.assert?.(response)
          })
        })
      }
    }

    if (!skipped.has('permission-gate')) {
      it('fails closed when permissions exceed backend support', async () => {
        await withBackend(backendOrFactory, async (backend) => {
          if (typeof backend.run !== 'function') return
          if (backend.capabilities.toolPermissions === 'native') return

          const registry = new BackendRegistry()
          registry.register(backend)

          const permissions =
            backend.capabilities.toolPermissions === 'wrapped'
              ? { networkEgress: 'allow' as const }
              : { allowedTools: ['gh.list_issues'] }

          const workflow = pipeline({
            id: `contract-${backend.id}-permissions`,
            steps: [
              agent({
                id: 'work',
                backend: backend.id,
                prompt: 'contract permission gate',
                permissions,
              }),
            ],
          })

          const run = await runPipeline(workflow, undefined, { backends: registry })
          expect(run.status).toBe('failed')
          expect(run.error?.name).toBe(BackendCapabilityError.name)
        })
      })
    }

    for (const adversarial of options.adversarialCases ?? []) {
      it(`adversarial (${adversarial.dimension}): ${adversarial.name} denies`, async () => {
        await withBackend(backendOrFactory, async (backend) => {
          if (typeof backend.run !== 'function') {
            throw new Error(
              `backend ${backend.id} has no run(); adversarial cases require an agent surface`,
            )
          }
          let thrown: unknown
          try {
            await backend.run(adversarial.request, buildContext(adversarial.context))
          } catch (err) {
            thrown = err
          }
          expect(thrown, `expected ${adversarial.dimension} adversarial run to throw`).toBeDefined()
          if (adversarial.assertRejection !== undefined) {
            await adversarial.assertRejection(thrown)
          } else {
            const expectedName = adversarial.expectedErrorName ?? 'PermissionDeniedError'
            expect((thrown as { name?: string } | undefined)?.name).toBe(expectedName)
          }
        })
      })
    }
  })
}

async function withBackend(
  backendOrFactory: SkelmBackend | (() => SkelmBackend | Promise<SkelmBackend>),
  run: (backend: SkelmBackend) => Promise<void>,
): Promise<void> {
  if (typeof backendOrFactory !== 'function') {
    await run(backendOrFactory)
    return
  }

  const backend = await backendOrFactory()
  try {
    await run(backend)
  } finally {
    await backend.dispose?.()
  }
}

function buildContext(context: Partial<BackendContext> = {}): BackendContext {
  return {
    signal: AbortSignal.timeout(5_000),
    ...context,
  }
}

function basicInferRequest(): InferRequest {
  return {
    messages: [{ role: 'user', content: 'ping' }],
  }
}

function basicAgentRequest(): AgentRequest {
  return {
    prompt: 'ping',
  }
}

function assertInferResponseShape(response: InferResponse, request: InferRequest): void {
  expect(response).toBeTypeOf('object')
  if (request.outputSchema !== undefined) {
    expect(response.structured).not.toBeUndefined()
  } else {
    expect(response.text !== undefined || response.structured !== undefined).toBe(true)
  }
  if (response.text !== undefined) {
    expect(typeof response.text).toBe('string')
  }
  assertUsageShape(response.usage)
}

function assertAgentResponseShape(response: AgentResponse, request: AgentRequest): void {
  expect(response).toBeTypeOf('object')
  if (request.outputSchema !== undefined) {
    expect(response.structured).not.toBeUndefined()
  } else {
    expect(response.text !== undefined || response.structured !== undefined).toBe(true)
  }
  if (response.text !== undefined) {
    expect(typeof response.text).toBe('string')
  }
  if (response.stopReason !== undefined) {
    expect(typeof response.stopReason).toBe('string')
  }
  assertUsageShape(response.usage)
}

function assertUsageShape(usage: Usage | undefined): void {
  if (usage === undefined) return
  for (const value of [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.reasoningTokens,
    usage.costUsd,
  ]) {
    if (value !== undefined) {
      expect(typeof value).toBe('number')
    }
  }
  if (usage.extras !== undefined) {
    for (const value of Object.values(usage.extras)) {
      expect(typeof value).toBe('number')
    }
  }
}
