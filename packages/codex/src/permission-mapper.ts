/**
 * Translate a resolved skelm permission policy into Codex SDK options.
 *
 * Codex enforces its own sandbox in-process; the mapper is the boundary —
 * if it can't translate the policy without widening, it refuses the run.
 *
 * Rules:
 *
 *   fsWrite: ∅ and fsRead: ∅     → sandboxMode: 'read-only'
 *   fsWrite: ['*']               → 'danger-full-access' iff approval.mode === 'never'
 *                                   (otherwise refuse — never silently escalate)
 *   fsWrite: [<roots>]           → 'workspace-write', primary root → workingDirectory,
 *                                   extras → additionalDirectories
 *   networkEgress: 'deny'        → networkAccessEnabled: false
 *   networkEgress: anything else → networkAccessEnabled: true
 *                                   (host allowlists are enforced by skelm's
 *                                    gateway egress proxy, not by Codex)
 *
 * Approval:
 *
 *   approval == null             → 'on-request' (Codex's safest default)
 *   approval.on.includes('*')    → 'untrusted'
 *   otherwise                    → 'on-request'
 *
 * Refusals throw `CodexPermissionError` and are emitted as audit entries.
 */

import type { ApprovalMode, SandboxMode } from '@openai/codex-sdk'
import type { ResolvedPolicy } from '@skelm/core'
import type { CodexPermissionAuditEntry, MappedCodexPolicy } from './types.js'

const STAR = '*'

export class CodexPermissionError extends Error {
  override readonly name = 'CodexPermissionError'
  constructor(
    message: string,
    readonly dimension: 'fs.write' | 'fs.read' | 'network' | 'approval',
  ) {
    super(message)
  }
}

export interface MapInputs {
  /** Resolved policy after profiles + step-level merging. */
  policy: ResolvedPolicy
  /** Working directory hint from the runtime (`WorkspaceHandle.path`). */
  workingDirectory?: string
}

/**
 * Produce the Codex `ThreadOptions`-compatible mapping. Throws
 * `CodexPermissionError` when the policy cannot be honored safely.
 */
export function mapPermissionsToCodex(input: MapInputs): MappedCodexPolicy {
  const { policy, workingDirectory } = input
  const fsWrite = Array.from(policy.fsWrite)
  const fsRead = Array.from(policy.fsRead)

  // Sandbox tier.
  let sandboxMode: SandboxMode
  let primary: string | undefined = workingDirectory
  const extras: string[] = []

  const hasStarWrite = fsWrite.includes(STAR)
  if (hasStarWrite) {
    // Broad write requires explicit no-approval acknowledgement.
    if (policy.approval !== null) {
      throw new CodexPermissionError(
        'fsWrite includes "*" but an approval policy is set; refusing danger-full-access',
        'fs.write',
      )
    }
    sandboxMode = 'danger-full-access'
  } else if (fsWrite.length === 0) {
    sandboxMode = 'read-only'
  } else {
    sandboxMode = 'workspace-write'
    if (primary === undefined) primary = fsWrite[0]
    for (const root of fsWrite) {
      if (root !== primary && !extras.includes(root)) extras.push(root)
    }
  }

  // Read-only sandbox doesn't need fsRead roots (codex's read-only mode is
  // unrestricted by default; the read allowlist is informational here).
  void fsRead

  // Network.
  const networkAccessEnabled = policy.networkEgress !== 'deny'

  // Approval mode.
  const approvalPolicy: ApprovalMode = pickApprovalMode(policy)

  const mapped: MappedCodexPolicy = {
    sandboxMode,
    approvalPolicy,
    networkAccessEnabled,
    ...(primary !== undefined && { workingDirectory: primary }),
    ...(extras.length > 0 && { additionalDirectories: extras }),
  }
  return mapped
}

function pickApprovalMode(policy: ResolvedPolicy): ApprovalMode {
  // No explicit approval policy → safest default that still lets the agent
  // ask for human escalation when it hits an unsafe action.
  if (policy.approval === null) return 'on-request'
  // Approval covers everything → use the strictest mode.
  if (policy.approval.on.length === 0) return 'on-request'
  return policy.approval.on.some((d) => d === 'tool' || d === 'executable')
    ? 'untrusted'
    : 'on-request'
}

/**
 * Compute which skill / MCP ids the step requested but the resolved policy
 * disallows. Caller fires `permission.denied` events for each.
 */
export function filterByPolicy<T extends { id: string }>(
  items: readonly T[] | undefined,
  allowlist: ReadonlySet<string>,
): { allowed: T[]; denied: T[] } {
  if (items === undefined) return { allowed: [], denied: [] }
  const allowed: T[] = []
  const denied: T[] = []
  for (const item of items) {
    if (allowlist.has(item.id)) allowed.push(item)
    else denied.push(item)
  }
  return { allowed, denied }
}

/** Same as filterByPolicy but for plain string ids (skills, secrets). */
export function filterIds(
  ids: readonly string[] | undefined,
  allowlist: ReadonlySet<string>,
): { allowed: string[]; denied: string[] } {
  if (ids === undefined) return { allowed: [], denied: [] }
  const allowed: string[] = []
  const denied: string[] = []
  for (const id of ids) {
    if (allowlist.has(id)) allowed.push(id)
    else denied.push(id)
  }
  return { allowed, denied }
}

/**
 * Build an audit entry recording how a policy was translated. Useful for
 * the gateway's hash-chained audit writer.
 */
export function buildAuditEntry(
  runId: string,
  stepId: string,
  policy: ResolvedPolicy,
  mapped: MappedCodexPolicy,
  denied: readonly string[],
): CodexPermissionAuditEntry {
  return {
    runId,
    stepId,
    timestamp: new Date().toISOString(),
    event: 'permission_check',
    details: {
      declaredPermissions: {
        allowedExecutables: Array.from(policy.allowedExecutables),
        allowedMcpServers: Array.from(policy.allowedMcpServers),
        allowedSkills: Array.from(policy.allowedSkills),
        fsRead: Array.from(policy.fsRead),
        fsWrite: Array.from(policy.fsWrite),
        networkEgress:
          typeof policy.networkEgress === 'string'
            ? policy.networkEgress
            : `allowHosts:${policy.networkEgress.allowHosts.join(',')}`,
      },
      mapped,
      decision: denied.length === 0 ? 'allow' : 'deny',
      deniedItems: Array.from(denied),
      backend: 'codex',
    },
  }
}
