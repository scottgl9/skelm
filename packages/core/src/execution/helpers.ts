import { BackendCapabilityError, type SkelmBackend } from '../backend.js'
import { MissingSecretError, type SecretResolver } from '../enforcement/index.js'
import { PermissionDeniedError } from '../errors.js'
import type { EventBus } from '../events.js'
import type { AgentPermissions, PermissionDimension, resolvePermissions } from '../permissions.js'
import { TrustEnforcer } from '../permissions.js'
import type { Skill } from '../skills.js'
import type { StepId } from '../types.js'
import type { ExecutionRuntime } from './runtime.js'

/**
 * Which permission *dimensions* the workflow author explicitly declared on
 * a step. Used to decide whether the resolved backend is even capable of
 * enforcing what was asked for.
 */
export function collectDeclaredPermissionDimensions(
  permissions: AgentPermissions | undefined,
  mcpServers: readonly unknown[] | undefined,
): ReadonlySet<PermissionDimension> {
  const declared = new Set<PermissionDimension>()
  if (permissions?.allowedTools !== undefined || permissions?.deniedTools !== undefined)
    declared.add('tool')
  if (permissions?.allowedExecutables !== undefined) declared.add('executable')
  if (permissions?.allowedMcpServers !== undefined || (mcpServers?.length ?? 0) > 0)
    declared.add('mcp')
  if (permissions?.allowedSkills !== undefined) declared.add('skill')
  if (permissions?.networkEgress !== undefined) declared.add('network')
  if (permissions?.fsRead !== undefined) declared.add('fs.read')
  if (permissions?.fsWrite !== undefined) declared.add('fs.write')
  return declared
}

export function assertBackendSupportsPermissions(
  stepId: string,
  backend: SkelmBackend,
  declared: ReadonlySet<PermissionDimension>,
  options: { hasEgressProxy?: boolean } = {},
): void {
  const unresolved = new Set(declared)
  if (backend.capabilities.mcp) {
    unresolved.delete('mcp')
  }
  // When the runtime supplies an egress proxy (gateway-driven runs), the
  // network dimension is enforced out-of-band by the proxy regardless of
  // the backend's own capability — so it does not need to be enforceable
  // by the backend.
  if (options.hasEgressProxy) {
    unresolved.delete('network')
  }
  if (unresolved.size === 0) return

  if (backend.capabilities.toolPermissions === 'unsupported') {
    // Name the capability class so the refusal is actionable instead of
    // generic: a `toolPermissions: 'unsupported'` backend (e.g. Pi RPC, which
    // runs the agent loop in a subprocess skelm cannot introspect) cannot
    // enforce any of the tool-class dimensions. Listing them here keeps this
    // pre-flight message consistent with the `'wrapped'` branch below and with
    // the backend's own defense-in-depth refusal, and surfaces the same
    // contract whether the constraint trips at pre-flight or inside run().
    throw new BackendCapabilityError(
      `backend ${backend.id} cannot enforce tool, executable, filesystem, MCP, or skill permissions for step "${stepId}" (declared: ${[...unresolved].join(', ')}). Use a backend with native tool-permission enforcement, or remove those dimensions and rely on networkEgress + the gateway egress proxy.`,
      backend.id,
      'toolPermissions',
    )
  }

  if (backend.capabilities.toolPermissions !== 'wrapped') return

  const unsupported = [...unresolved].filter(
    (dimension) => !['tool', 'executable'].includes(dimension),
  )
  if (unsupported.length === 0) return

  throw new BackendCapabilityError(
    `backend ${backend.id} cannot enforce ${unsupported.join(', ')} permissions in wrapped mode for step "${stepId}"`,
    backend.id,
    'toolPermissions',
  )
}

/**
 * Shallow-copy an ExecutionRuntime with an independent currentWorkspace
 * slot. Used by parallel / forEach branches so concurrent siblings don't
 * stomp on each other's workspace state.
 */
export function createDetachedWorkspaceRuntime(
  runtime: ExecutionRuntime | undefined,
): ExecutionRuntime | undefined {
  if (runtime === undefined) return undefined
  let currentWorkspace = runtime.currentWorkspace
  return {
    workspaceManager: runtime.workspaceManager,
    stateStore: runtime.stateStore,
    ...(runtime.store !== undefined && { store: runtime.store }),
    ...(runtime.defaultPermissions !== undefined && {
      defaultPermissions: runtime.defaultPermissions,
    }),
    ...(runtime.permissionProfiles !== undefined && {
      permissionProfiles: runtime.permissionProfiles,
    }),
    ...(runtime.unrestrictedGrant !== undefined && {
      unrestrictedGrant: runtime.unrestrictedGrant,
    }),
    ...(runtime.skillSource !== undefined && { skillSource: runtime.skillSource }),
    ...(runtime.secretResolver !== undefined && { secretResolver: runtime.secretResolver }),
    ...(runtime.registerEgressToken !== undefined && {
      registerEgressToken: runtime.registerEgressToken,
    }),
    ...(runtime.unregisterEgressToken !== undefined && {
      unregisterEgressToken: runtime.unregisterEgressToken,
    }),
    ...(runtime.getProxyEnv !== undefined && { getProxyEnv: runtime.getProxyEnv }),
    ...(runtime.agentmemoryHandleFactory !== undefined && {
      agentmemoryHandleFactory: runtime.agentmemoryHandleFactory,
    }),
    currentWorkspace,
    setCurrentWorkspace: (workspace) => {
      currentWorkspace = workspace
    },
    deferRunWorkspaceFinalizer: runtime.deferRunWorkspaceFinalizer,
  }
}

/**
 * A per-step skill loader that defense-in-depths the policy's allowedSkills
 * — even though the runner already checks at the boundary, every load goes
 * through this enforcer so a permissive backend can't surprise us.
 */
export function makeSkillLoader(
  source: (skillId: string) => Promise<Skill | null>,
  enforcer: TrustEnforcer,
  events: EventBus | undefined,
  runId: string,
  stepId: string,
): (skillId: string) => Promise<Skill | null> {
  const cache = new Map<string, Promise<Skill | null>>()
  return (skillId) => {
    const hit = cache.get(skillId)
    if (hit !== undefined) return hit
    const decision = enforcer.canLoadSkill(skillId)
    if (!decision.allow) {
      events?.publish({
        type: 'permission.denied',
        runId,
        stepId,
        dimension: 'skill',
        detail: `skill "${skillId}" is not in allowedSkills (${decision.reason})`,
        at: Date.now(),
      })
      const denied = Promise.resolve(null)
      cache.set(skillId, denied)
      return denied
    }
    const promise = source(skillId)
    cache.set(skillId, promise)
    return promise
  }
}

export async function resolveDeclaredSecrets(
  step: { readonly id: StepId; readonly secrets?: readonly string[] },
  policy: ReturnType<typeof resolvePermissions> | undefined,
  resolver: SecretResolver | undefined,
  events: EventBus | undefined,
  runId: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  if (step.secrets === undefined || step.secrets.length === 0) return undefined
  const enforcer = policy !== undefined ? new TrustEnforcer(policy) : undefined
  const resolved: Record<string, string> = {}
  for (const name of step.secrets) {
    if (enforcer !== undefined) {
      const decision = enforcer.canAccessSecret(name)
      if (!decision.allow) {
        const detail = `step "${step.id}" is not allowed to access secret "${name}" (${decision.reason})`
        events?.publish({
          type: 'permission.denied',
          runId,
          stepId: step.id,
          dimension: 'secret',
          detail,
          at: Date.now(),
        })
        throw new PermissionDeniedError(detail)
      }
    }
    if (resolver === undefined) {
      throw new Error(
        `step "${step.id}" declares secret "${name}" but no SecretResolver is configured`,
      )
    }
    const value = await resolver.resolve(name)
    if (value === undefined) {
      events?.publish({
        type: 'secret.not_found',
        runId,
        stepId: step.id,
        name,
        at: Date.now(),
      })
      throw new MissingSecretError(name)
    }
    resolved[name] = value
    events?.publish({
      type: 'secret.accessed',
      runId,
      stepId: step.id,
      name,
      at: Date.now(),
    })
  }
  return Object.freeze(resolved)
}

export function collectResolvedPermissionDimensions(
  policy: ReturnType<typeof resolvePermissions> | undefined,
  mcpServers: readonly unknown[] | undefined,
): ReadonlySet<PermissionDimension> {
  const declared = new Set<PermissionDimension>()
  if (policy === undefined) {
    if ((mcpServers?.length ?? 0) > 0) declared.add('mcp')
    return declared
  }
  if (
    policy.allowedTools.exact.size > 0 ||
    policy.allowedTools.prefixes.length > 0 ||
    policy.allowedTools.star ||
    policy.deniedTools.exact.size > 0 ||
    policy.deniedTools.prefixes.length > 0 ||
    policy.deniedTools.star
  ) {
    declared.add('tool')
  }
  if (policy.allowedExecutables.size > 0) declared.add('executable')
  if (policy.allowedMcpServers.size > 0 || (mcpServers?.length ?? 0) > 0) declared.add('mcp')
  if (policy.allowedSkills.size > 0) declared.add('skill')
  if (policy.networkEgress === 'allow' || typeof policy.networkEgress === 'object') {
    declared.add('network')
  }
  if (policy.fsRead.size > 0) declared.add('fs.read')
  if (policy.fsWrite.size > 0) declared.add('fs.write')
  return declared
}
