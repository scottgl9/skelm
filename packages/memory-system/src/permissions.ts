import { type AgentmemoryClient, createAgentmemoryHandle } from '@skelm/agentmemory'
import {
  type AgentPermissions,
  type AgentmemoryHandle,
  type AgentmemoryOperation,
  TrustEnforcer,
  resolvePermissions,
} from '@skelm/core'

/**
 * Per-workflow agentmemory permission ceilings. Each workflow declares only the
 * ops it needs; every other dimension stays `undefined`, which the runtime
 * treats as deny. These are the manifest's `permissions` blocks in code form so
 * the entrypoints and the manifest stay in lockstep.
 *
 * Default-deny is structural: omit a flag and the corresponding op is refused
 * at the handle, not silently allowed.
 *
 * Each ceiling also grants only the one secret name the workflow needs to
 * authenticate to the agentmemory server — `allowedSecrets` is itself
 * default-deny once `permissions` is present.
 */
export const MEMORY_SECRET = 'AGENTMEMORY_TOKEN'

const SECRET: AgentPermissions = { allowedSecrets: [MEMORY_SECRET] }

export const WORKFLOW_PERMISSIONS = {
  // Reads recent sessions/memories, writes a daily rollup note.
  'daily-note': { ...SECRET, agentmemory: { allowRecall: true, allowSave: true } },
  // Reads a session's observations, writes one summary memory.
  'session-summary': { ...SECRET, agentmemory: { allowRecall: true, allowSave: true } },
  // Reads older memories and rewrites them under an archive concept.
  'weekly-archive': { ...SECRET, agentmemory: { allowRecall: true, allowSave: true } },
  // Searches near-duplicate clusters and folds them into one memory.
  consolidation: { ...SECRET, agentmemory: { allowSearch: true, allowSave: true } },
  // Recalls candidates and re-saves the strongest under a promoted concept.
  promotion: { ...SECRET, agentmemory: { allowRecall: true, allowSave: true } },
  // Read-only: recalls memories and reports which are stale. No save.
  'stale-prune': { ...SECRET, agentmemory: { allowRecall: true } },
  // Read-only: exercises search to gauge index health.
  'search-health': { ...SECRET, agentmemory: { allowSearch: true } },
  // Read-only: recalls + graph-queries to audit referential integrity.
  'integrity-audit': { ...SECRET, agentmemory: { allowRecall: true, allowGraph: true } },
} as const satisfies Record<string, AgentPermissions>

export type MemoryWorkflowId = keyof typeof WORKFLOW_PERMISSIONS

/**
 * Build a permission-gated `AgentmemoryHandle` for one workflow. This runs the
 * real gateway enforcement path — `resolvePermissions` then `TrustEnforcer` —
 * so a workflow whose declared ceiling omits an op gets a handle that denies
 * that op. Tests use this with the declared ceilings to prove default-deny;
 * production wires the same path with the gateway's client.
 */
export function buildWorkflowHandle(opts: {
  client: AgentmemoryClient
  workflow: MemoryWorkflowId
  project: string
  events?: (event: unknown) => void
}): AgentmemoryHandle {
  const policy = resolvePermissions(undefined, WORKFLOW_PERMISSIONS[opts.workflow])
  const enforcer = new TrustEnforcer(policy)
  return createAgentmemoryHandle({
    client: opts.client,
    canUseAgentmemory: (op: AgentmemoryOperation) => enforcer.canUseAgentmemory(op),
    defaultProject: opts.project,
    ...(opts.events !== undefined ? { events: opts.events } : {}),
  })
}
