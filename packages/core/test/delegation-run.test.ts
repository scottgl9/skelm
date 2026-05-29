import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import {
  DelegationCycleError,
  DelegationDepthError,
  InvokePipelineNotFoundError,
} from '../src/errors.js'
import { type DelegationCaller, runDelegation } from '../src/execution/handlers.js'
import type { ExecutionRuntime } from '../src/execution/runtime.js'
import { resolvePermissions } from '../src/permissions.js'
import type { Pipeline } from '../src/types.js'

// Mechanics of the runDelegation helper: target resolution, the structured
// envelope, and the cycle / depth guards. The ceiling-bounding security
// property is covered in security/delegation-bounding.test.ts.

const specialist = pipeline({
  id: 'specialist',
  steps: [code({ id: 'answer', run: (ctx) => ({ echoed: ctx.input }) })],
})

function makeRuntime(
  overrides: Partial<ExecutionRuntime> & {
    pipelineRegistry: ExecutionRuntime['pipelineRegistry']
  },
): ExecutionRuntime {
  return {
    delegationStack: ['root'],
    delegationDepth: 0,
    maxDelegationDepth: 8,
    ...overrides,
  } as unknown as ExecutionRuntime
}

function makeCaller(): DelegationCaller {
  return {
    runId: 'parent-run',
    stepId: 'router',
    signal: new AbortController().signal,
    ceiling: resolvePermissions(undefined, { allowedTools: ['*'] }),
  }
}

const registryOf =
  (map: Record<string, Pipeline>): ExecutionRuntime['pipelineRegistry'] =>
  (id: string) =>
    map[id]

describe('runDelegation — mechanics', () => {
  it('returns a completed envelope with the child output and run id', async () => {
    const runtime = makeRuntime({ pipelineRegistry: registryOf({ specialist }) })
    const result = await runDelegation('specialist', { q: 1 }, makeCaller(), runtime, undefined)
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ echoed: { q: 1 } })
    expect(typeof result.runId).toBe('string')
    expect(result.runId.length).toBeGreaterThan(0)
  })

  it('throws InvokePipelineNotFoundError when the target id is unknown', async () => {
    const runtime = makeRuntime({ pipelineRegistry: registryOf({ specialist }) })
    await expect(
      runDelegation('nope', undefined, makeCaller(), runtime, undefined),
    ).rejects.toBeInstanceOf(InvokePipelineNotFoundError)
  })

  it('refuses a target already on the delegation chain (cycle)', async () => {
    const runtime = makeRuntime({
      pipelineRegistry: registryOf({ specialist }),
      delegationStack: ['root', 'specialist'],
    })
    await expect(
      runDelegation('specialist', undefined, makeCaller(), runtime, undefined),
    ).rejects.toBeInstanceOf(DelegationCycleError)
  })

  it('refuses a delegation that would exceed the max depth', async () => {
    const runtime = makeRuntime({
      pipelineRegistry: registryOf({ specialist }),
      delegationDepth: 8,
      maxDelegationDepth: 8,
    })
    await expect(
      runDelegation('specialist', undefined, makeCaller(), runtime, undefined),
    ).rejects.toBeInstanceOf(DelegationDepthError)
  })

  it('returns a failed envelope when the child run fails', async () => {
    const boom = pipeline({
      id: 'boom',
      steps: [
        code({
          id: 'throw',
          run: () => {
            throw new Error('child blew up')
          },
        }),
      ],
    })
    const runtime = makeRuntime({ pipelineRegistry: registryOf({ boom }) })
    const result = await runDelegation('boom', undefined, makeCaller(), runtime, undefined)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('child blew up')
  })
})
