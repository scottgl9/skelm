import { AgentmemoryClient } from '@skelm/agentmemory'
import type { Context } from '@skelm/core'
import { type MemorySystemConfig, resolveMemorySystemConfig } from '../config.js'
import { MEMORY_SECRET, type MemoryWorkflowId, buildWorkflowHandle } from '../permissions.js'
import type { MemorySystemDeps, Summarizer } from '../types.js'

/**
 * Assemble per-run `MemorySystemDeps` inside a `code()` step. Builds an
 * `AgentmemoryClient` from config + the run's resolved secret, then wraps it in
 * a permission-gated handle for the named workflow so the declared ceiling is
 * enforced through the real `TrustEnforcer` path. State comes from the step's
 * `ctx.state`. The summarizer, when supplied, is provided by the caller (an
 * `infer()` step output bridged in); otherwise it is omitted.
 */
export function assembleDeps(
  ctx: Context,
  workflow: MemoryWorkflowId,
  opts: { config?: MemorySystemConfig; url?: string; summarizer?: Summarizer } = {},
): { deps: MemorySystemDeps; config: MemorySystemConfig } {
  const config = opts.config ?? resolveMemorySystemConfig()
  const secret = ctx.secrets?.get(MEMORY_SECRET)
  const client = new AgentmemoryClient({
    url: opts.url ?? process.env.SKELM_AGENTMEMORY_URL ?? 'http://localhost:3111',
    ...(secret !== undefined ? { secret } : {}),
  })
  const memory = buildWorkflowHandle({ client, workflow, project: config.project })
  const deps: MemorySystemDeps = {
    memory,
    state: ctx.state,
    project: config.project,
    ...(opts.summarizer !== undefined ? { summarizer: opts.summarizer } : {}),
  }
  return { deps, config }
}

export { MEMORY_SECRET }
