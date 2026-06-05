// AgentPermissions: the default-deny security model for agent steps. Authors
// declare what a step may do; the runtime intersects project defaults + profile
// + step-level + workspace into a final policy and enforces it through one
// helper (TrustEnforcer) — backends and tools never branch on policy themselves.

import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PermissionDeniedError } from './errors.js'
import { isMetadataAddress } from './net-classify.js'

/** Dimensions of the permission model. Each defaults to deny when omitted. */
export type PermissionDimension =
  | 'tool'
  | 'executable'
  | 'mcp'
  | 'skill'
  | 'secret'
  | 'network'
  | 'fs.read'
  | 'fs.write'
  | 'agentmemory'
  | 'delegation'

/**
 * Every permission dimension, used for forensic enumeration (audit log
 * fan-out under unrestricted bypass) and for guards that need to assert
 * coverage across the dimension set.
 */
export const ALL_PERMISSION_DIMENSIONS = [
  'tool',
  'executable',
  'mcp',
  'skill',
  'secret',
  'network',
  'fs.read',
  'fs.write',
  'agentmemory',
  'delegation',
] as const satisfies readonly PermissionDimension[]

/**
 * Operations the agentmemory dimension can independently allow.
 *
 * `recall` gates both the sessions-list and the recent/by-session recall
 * calls — they are the same read trust decision.
 */
export type AgentmemoryOperation =
  | 'observe'
  | 'search'
  | 'session'
  | 'context'
  | 'save'
  | 'recall'
  | 'graph'

/**
 * Single source of truth for the agentmemory op set. Iterating this is
 * how the runner asks "does this resolved policy permit any agentmemory
 * op?" and how the gateway decides whether to hand the step a handle.
 */
export const ALL_AGENTMEMORY_OPS = [
  'observe',
  'search',
  'session',
  'context',
  'save',
  'recall',
  'graph',
] as const satisfies readonly AgentmemoryOperation[]

/**
 * Per-operation gate for the agentmemory dimension. Each flag defaults to
 * deny when omitted. `'deny'` blocks every op as a quick disable.
 */
export type AgentmemoryPolicy =
  | 'deny'
  | {
      allowObserve?: boolean
      allowSearch?: boolean
      allowSession?: boolean
      allowContext?: boolean
      allowSave?: boolean
      allowRecall?: boolean
      allowGraph?: boolean
    }

/** Network egress policy. */
export type NetworkPolicy = 'allow' | 'deny' | { allowHosts: readonly string[] }

/** A tool matcher: explicit ids, prefix patterns, or `*` for everything. */
export type ToolMatcher =
  | readonly string[]
  | { exact?: readonly string[]; prefixes?: readonly string[]; star?: boolean }

/** Approval policy (deferred to a future stage; type carried for forward-compat). */
export interface ApprovalPolicy {
  /** Dimensions that gate on approval. */
  on: readonly PermissionDimension[]
  /** Cache duration after an approval is granted. */
  rememberFor?: number
}

/** What an `agent()` step author writes. Every field is optional; default is deny. */
export interface AgentPermissions {
  /** Named project profile applied before step-level narrowing. */
  profile?: string
  /** Tool ids the agent may call (e.g. `gh.list_issues`). */
  allowedTools?: ToolMatcher
  /** Tool ids explicitly forbidden even if `allowedTools` would permit. */
  deniedTools?: ToolMatcher
  /** Executables allowed for any exec/bash tool. */
  allowedExecutables?: readonly string[]
  /** MCP server ids permitted to attach. */
  allowedMcpServers?: readonly string[]
  /** Skill ids permitted to load. */
  allowedSkills?: readonly string[]
  /**
   * Pipeline / agent ids this agent step may hand off to via the `delegate`
   * tool. Matched like `allowedTools` (exact ids, `foo.*` prefixes, or `*`).
   * Default-deny: omitted means the agent cannot delegate to anything. A
   * delegated child's effective permissions are intersected with the parent's,
   * so this allowlist can only shrink down the delegation chain.
   */
  delegation?: ToolMatcher
  /** Secret names the agent step is permitted to access. */
  allowedSecrets?: readonly string[]
  /** Network egress policy. */
  networkEgress?: NetworkPolicy
  /** Path roots the agent may read. */
  fsRead?: readonly string[]
  /** Path roots the agent may write. */
  fsWrite?: readonly string[]
  /** Approval gating policy. */
  approval?: ApprovalPolicy
  /**
   * Per-operation gate for the agentmemory integration. Default-deny: an
   * omitted field denies every agentmemory call (observe/search/session/
   * context/save/recall/graph). See `@skelm/agentmemory` for the integration
   * that consumes this dimension.
   */
  agentmemory?: AgentmemoryPolicy
  /**
   * Author REQUEST for a full permission bypass (a freewheeling assistant).
   * Inert on its own: it only takes effect when the operator also grants the
   * workflow id in gateway config (`defaults.unrestrictedGrants`). A pipeline
   * can therefore never self-escalate — `resolvePermissions` only honours this
   * when the gateway passes `{ grantUnrestricted: true }`. Default-deny:
   * omitted (or operator-ungranted) keeps normal per-dimension enforcement.
   */
  requestUnrestricted?: boolean
}

/** A frozen, normalized policy ready for enforcement. Built by `resolvePermissions`. */
export interface ResolvedPolicy {
  readonly allowedTools: ResolvedToolMatcher
  readonly deniedTools: ResolvedToolMatcher
  readonly allowedExecutables: ReadonlySet<string>
  readonly allowedMcpServers: ReadonlySet<string>
  readonly allowedSkills: ReadonlySet<string>
  readonly allowedAgents: ResolvedToolMatcher
  readonly allowedSecrets: ReadonlySet<string>
  readonly networkEgress: NetworkPolicy
  readonly fsRead: ReadonlySet<string>
  readonly fsWrite: ReadonlySet<string>
  readonly approval: ApprovalPolicy | null
  readonly agentmemory: ResolvedAgentmemoryPolicy
  /**
   * Full bypass: when `true`, `TrustEnforcer` short-circuits every dimension to
   * allow. Set only when an author requested it AND the operator granted it
   * (see `resolvePermissions` opts). Optional so hand-built policies default to
   * normal enforcement; omitted is treated as `false`.
   */
  readonly unrestricted?: boolean
}

/** Frozen, normalized agentmemory policy. */
export interface ResolvedAgentmemoryPolicy {
  readonly allowObserve: boolean
  readonly allowSearch: boolean
  readonly allowSession: boolean
  readonly allowContext: boolean
  readonly allowSave: boolean
  readonly allowRecall: boolean
  readonly allowGraph: boolean
}

/** Internal canonical shape of a tool matcher used for O(1) lookups. */
export interface ResolvedToolMatcher {
  readonly exact: ReadonlySet<string>
  readonly prefixes: readonly string[]
  readonly star: boolean
}

/** Reason a privileged action was denied; surfaced to event/audit payloads. */
export type PermissionDenialReason =
  | 'no-policy'
  | 'not-in-allowlist'
  | 'in-denylist'
  | 'host-not-allowed'
  | 'path-not-in-allowlist'
  | 'star-disallowed-in-prod'

/** Structured decision returned by every TrustEnforcer.canX method. */
export type EnforceDecision =
  | { allow: true }
  | { allow: false; reason: PermissionDenialReason; dimension: PermissionDimension }

const EMPTY_MATCHER: ResolvedToolMatcher = Object.freeze({
  exact: new Set<string>(),
  prefixes: Object.freeze([]),
  star: false,
})

/** Options supplied ONLY by the trust boundary (gateway), never by an author. */
export interface ResolvePermissionsOptions {
  /**
   * Operator grant for the full bypass. When `true` AND some input layer set
   * `requestUnrestricted`, the resolved policy is `unrestricted`. The author
   * side alone can never set this — that is what keeps a pipeline from
   * self-escalating.
   */
  grantUnrestricted?: boolean
}

/**
 * Resolve a permission policy from project defaults + step-level fields.
 * Intersection-only: nothing widens. The returned policy is immutable.
 */
export function resolvePermissions(
  defaults: AgentPermissions | undefined,
  stepLevel: AgentPermissions | undefined,
  profiles: Readonly<Record<string, AgentPermissions>> = {},
  opts: ResolvePermissionsOptions = {},
): ResolvedPolicy {
  const profile =
    stepLevel?.profile === undefined
      ? undefined
      : (profiles[stepLevel.profile] ??
        (() => {
          throw new Error(`unknown permission profile: ${stepLevel.profile}`)
        })())
  const inputs = [defaults, profile, stripProfile(stepLevel)].filter(
    (p): p is AgentPermissions => p !== undefined,
  )

  // Two-key bypass: only true when the operator granted it AND an author layer
  // requested it. `requestUnrestricted` never participates in the intersection
  // math below — it cannot widen any allow-list, only flip this flag.
  const requested = inputs.some((p) => p.requestUnrestricted === true)
  const unrestricted = opts.grantUnrestricted === true && requested

  return Object.freeze({
    allowedTools: intersectToolMatchers(inputs.map((p) => p.allowedTools)),
    deniedTools: unionToolMatchers(inputs.map((p) => p.deniedTools)),
    allowedExecutables: intersectExecutables(inputs.map((p) => p.allowedExecutables)),
    allowedMcpServers: intersectStrings(inputs.map((p) => p.allowedMcpServers)),
    allowedSkills: intersectStrings(inputs.map((p) => p.allowedSkills)),
    allowedAgents: intersectToolMatchers(inputs.map((p) => p.delegation)),
    allowedSecrets: intersectStrings(inputs.map((p) => p.allowedSecrets)),
    networkEgress: intersectNetwork(inputs.map((p) => p.networkEgress)),
    fsRead: intersectStrings(inputs.map((p) => p.fsRead)),
    fsWrite: intersectStrings(inputs.map((p) => p.fsWrite)),
    approval: lastDefined(inputs.map((p) => p.approval)) ?? null,
    agentmemory: intersectAgentmemory(inputs.map((p) => p.agentmemory)),
    unrestricted,
  })
}

/**
 * Intersect two already-resolved policies into the strict lower bound of both.
 * Used to bound a delegated child agent to a subset of its parent's grant:
 * `ceiling` is the parent's resolved policy (what it was actually granted),
 * `child` is the child run's own resolved policy. Nothing in the result widens
 * beyond `ceiling`.
 *
 * `unrestricted` follows the parent: an unrestricted ceiling imposes no
 * constraint and fully empowers the child; a restricted ceiling caps the child
 * to normal per-dimension enforcement regardless of the child's own grant, so a
 * restricted parent can never produce an unrestricted child. Denylists are
 * unioned (a parent's denies also bind the child) and approval gating is unioned
 * (if either side gates a dimension, the child gates on it).
 */
export function intersectResolvedPolicies(
  ceiling: ResolvedPolicy,
  child: ResolvedPolicy,
): ResolvedPolicy {
  if (ceiling.unrestricted === true) {
    return Object.freeze({ ...child, unrestricted: true })
  }
  return Object.freeze({
    allowedTools: intersectResolvedMatchers(ceiling.allowedTools, child.allowedTools),
    deniedTools: unionResolvedMatchers(ceiling.deniedTools, child.deniedTools),
    allowedExecutables: intersectStringSets(ceiling.allowedExecutables, child.allowedExecutables),
    allowedMcpServers: intersectStringSets(ceiling.allowedMcpServers, child.allowedMcpServers),
    allowedSkills: intersectStringSets(ceiling.allowedSkills, child.allowedSkills),
    allowedAgents: intersectResolvedMatchers(ceiling.allowedAgents, child.allowedAgents),
    allowedSecrets: intersectStringSets(ceiling.allowedSecrets, child.allowedSecrets),
    networkEgress: narrowNetwork(ceiling.networkEgress, child.networkEgress),
    fsRead: intersectStringSets(ceiling.fsRead, child.fsRead),
    fsWrite: intersectStringSets(ceiling.fsWrite, child.fsWrite),
    approval: unionApproval(ceiling.approval, child.approval),
    agentmemory: intersectResolvedAgentmemory(ceiling.agentmemory, child.agentmemory),
    unrestricted: false,
  })
}

// Semantic intersection for ceiling bounding: the result matches an id iff
// BOTH matchers match it. Unlike the structural author-layer intersection,
// a `*` ceiling does not erase a narrower child matcher — it imposes no
// constraint — and an exact id is kept when the other side's prefix covers it.
function intersectResolvedMatchers(
  a: ResolvedToolMatcher,
  b: ResolvedToolMatcher,
): ResolvedToolMatcher {
  if (a.star) return b
  if (b.star) return a
  const exact = new Set<string>()
  for (const x of a.exact) {
    if (matches(b, x)) exact.add(x)
  }
  for (const x of b.exact) {
    if (matches(a, x)) exact.add(x)
  }
  const prefixes: string[] = []
  const keep = (p: string) => {
    if (!prefixes.includes(p)) prefixes.push(p)
  }
  for (const pa of a.prefixes) {
    for (const pb of b.prefixes) {
      // The intersection of two prefixes is the more specific one, but only
      // when one is a prefix of the other; disjoint prefixes match nothing.
      if (pa.startsWith(pb)) keep(pa)
      else if (pb.startsWith(pa)) keep(pb)
    }
  }
  return Object.freeze({ exact, prefixes: Object.freeze(prefixes), star: false })
}

function unionResolvedMatchers(
  a: ResolvedToolMatcher,
  b: ResolvedToolMatcher,
): ResolvedToolMatcher {
  const prefixes = [...a.prefixes]
  for (const p of b.prefixes) {
    if (!prefixes.includes(p)) prefixes.push(p)
  }
  return Object.freeze({
    exact: new Set([...a.exact, ...b.exact]),
    prefixes: Object.freeze(prefixes),
    star: a.star || b.star,
  })
}

function intersectStringSets(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const x of a) {
    if (b.has(x)) out.add(x)
  }
  return out
}

function intersectResolvedAgentmemory(
  a: ResolvedAgentmemoryPolicy,
  b: ResolvedAgentmemoryPolicy,
): ResolvedAgentmemoryPolicy {
  return Object.freeze({
    allowObserve: a.allowObserve && b.allowObserve,
    allowSearch: a.allowSearch && b.allowSearch,
    allowSession: a.allowSession && b.allowSession,
    allowContext: a.allowContext && b.allowContext,
    allowSave: a.allowSave && b.allowSave,
    allowRecall: a.allowRecall && b.allowRecall,
    allowGraph: a.allowGraph && b.allowGraph,
  })
}

function unionApproval(a: ApprovalPolicy | null, b: ApprovalPolicy | null): ApprovalPolicy | null {
  if (a === null) return b
  if (b === null) return a
  const on = [...a.on]
  for (const dim of b.on) {
    if (!on.includes(dim)) on.push(dim)
  }
  const rememberFor =
    a.rememberFor === undefined
      ? b.rememberFor
      : b.rememberFor === undefined
        ? a.rememberFor
        : Math.min(a.rememberFor, b.rememberFor)
  return {
    on: Object.freeze(on),
    ...(rememberFor !== undefined && { rememberFor }),
  }
}

const AGENTMEMORY_DENY: ResolvedAgentmemoryPolicy = Object.freeze({
  allowObserve: false,
  allowSearch: false,
  allowSession: false,
  allowContext: false,
  allowSave: false,
  allowRecall: false,
  allowGraph: false,
})

function intersectAgentmemory(
  policies: ReadonlyArray<AgentmemoryPolicy | undefined>,
): ResolvedAgentmemoryPolicy {
  const present = policies.filter((p): p is AgentmemoryPolicy => p !== undefined)
  if (present.length === 0) return AGENTMEMORY_DENY
  let acc: ResolvedAgentmemoryPolicy | null = null
  for (const p of present) {
    if (p === 'deny') return AGENTMEMORY_DENY
    const normalized: ResolvedAgentmemoryPolicy = Object.freeze({
      allowObserve: p.allowObserve === true,
      allowSearch: p.allowSearch === true,
      allowSession: p.allowSession === true,
      allowContext: p.allowContext === true,
      allowSave: p.allowSave === true,
      allowRecall: p.allowRecall === true,
      allowGraph: p.allowGraph === true,
    })
    acc =
      acc === null
        ? normalized
        : Object.freeze({
            allowObserve: acc.allowObserve && normalized.allowObserve,
            allowSearch: acc.allowSearch && normalized.allowSearch,
            allowSession: acc.allowSession && normalized.allowSession,
            allowContext: acc.allowContext && normalized.allowContext,
            allowSave: acc.allowSave && normalized.allowSave,
            allowRecall: acc.allowRecall && normalized.allowRecall,
            allowGraph: acc.allowGraph && normalized.allowGraph,
          })
  }
  return acc ?? AGENTMEMORY_DENY
}

/**
 * Lightweight enforcer: exposes `canX` predicates that return a structured
 * decision. The runtime calls these before performing any privileged action.
 */
export class TrustEnforcer {
  constructor(readonly policy: ResolvedPolicy) {}

  canCallTool(toolId: string): EnforceDecision {
    if (this.policy.unrestricted === true) return { allow: true }
    if (matches(this.policy.deniedTools, toolId)) {
      return { allow: false, reason: 'in-denylist', dimension: 'tool' }
    }
    if (!matches(this.policy.allowedTools, toolId)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'tool' }
    }
    return { allow: true }
  }

  canDelegate(agentId: string): EnforceDecision {
    if (this.policy.unrestricted === true) return { allow: true }
    if (!matches(this.policy.allowedAgents, agentId)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'delegation' }
    }
    return { allow: true }
  }

  canExec(binary: string): EnforceDecision {
    if (this.policy.unrestricted === true) return { allow: true }
    // A binary is allowed only by an exact allowlist entry. We deliberately do
    // NOT fall back to the basename of a path-bearing binary: an allowlist of
    // ['git'] must never accept '/tmp/evil/git' (the basename-bypass closed in
    // 0366b65). Bare names match as-is (basename === name); invoking by path
    // requires the exact path to be allowlisted.
    if (this.policy.allowedExecutables.has(binary)) {
      return { allow: true }
    }
    return {
      allow: false,
      reason: hasPathSeparator(binary) ? 'path-not-in-allowlist' : 'not-in-allowlist',
      dimension: 'executable',
    }
  }

  canAttachMcpServer(serverId: string): EnforceDecision {
    if (this.policy.unrestricted === true) return { allow: true }
    if (!this.policy.allowedMcpServers.has(serverId)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'mcp' }
    }
    return { allow: true }
  }

  canLoadSkill(skillId: string): EnforceDecision {
    if (this.policy.unrestricted === true) return { allow: true }
    if (!this.policy.allowedSkills.has(skillId)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'skill' }
    }
    return { allow: true }
  }

  canAccessSecret(name: string): EnforceDecision {
    if (this.policy.unrestricted === true) return { allow: true }
    if (!this.policy.allowedSecrets.has(name)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'secret' }
    }
    return { allow: true }
  }

  canFetch(host: string): EnforceDecision {
    if (this.policy.unrestricted === true) return { allow: true }
    const policy = this.policy.networkEgress
    if (policy === 'allow') return { allow: true }
    if (policy === 'deny') return { allow: false, reason: 'no-policy', dimension: 'network' }
    if (typeof policy === 'object' && policy.allowHosts.includes(host)) {
      return { allow: true }
    }
    return { allow: false, reason: 'host-not-allowed', dimension: 'network' }
  }

  canUseAgentmemory(op: AgentmemoryOperation): EnforceDecision {
    if (this.policy.unrestricted === true) return { allow: true }
    const p = this.policy.agentmemory
    const allow: Record<AgentmemoryOperation, boolean> = {
      observe: p.allowObserve,
      search: p.allowSearch,
      session: p.allowSession,
      context: p.allowContext,
      save: p.allowSave,
      recall: p.allowRecall,
      graph: p.allowGraph,
    }
    if (allow[op]) return { allow: true }
    return { allow: false, reason: 'not-in-allowlist', dimension: 'agentmemory' }
  }

  canRead(path: string): EnforceDecision {
    return this.canFsAccess(path, this.policy.fsRead, 'fs.read')
  }

  canWrite(path: string): EnforceDecision {
    return this.canFsAccess(path, this.policy.fsWrite, 'fs.write')
  }

  private canFsAccess(
    path: string,
    roots: ReadonlySet<string> | undefined,
    dimension: 'fs.read' | 'fs.write',
  ): EnforceDecision {
    if (this.policy.unrestricted === true) return { allow: true }
    if (!roots || roots.size === 0)
      return { allow: false, reason: 'path-not-in-allowlist', dimension }
    const normalized = normalizeFsPath(path)
    for (const rawRoot of roots) {
      const root = normalizeFsPath(rawRoot.endsWith('/') ? rawRoot.slice(0, -1) : rawRoot)
      if (normalized === root || normalized.startsWith(`${root}/`)) {
        return { allow: true }
      }
    }
    return { allow: false, reason: 'path-not-in-allowlist', dimension }
  }
}

// Collapses `.` and `..` segments so a request for `/data/../etc/passwd`
// cannot satisfy a `/data` allowlist root via a string-prefix shortcut.
// Relative inputs resolve against `/` deliberately — fs allowlists are
// declared as absolute paths and we want to compare on the same axis.
function normalizeFsPath(p: string): string {
  const abs = isAbsolute(p) ? p : `/${p}`
  return resolvePath(abs)
}

// ── helpers ─────────────────────────────────────────────────────────────────

function intersectStrings(
  arrays: ReadonlyArray<readonly string[] | undefined>,
): ReadonlySet<string> {
  const present = arrays.filter((a): a is readonly string[] => a !== undefined)
  if (present.length === 0) return new Set()
  let acc: Set<string> = new Set(present[0])
  for (let i = 1; i < present.length; i++) {
    const next = new Set<string>()
    const a = present[i]
    if (a !== undefined) {
      for (const item of a) {
        if (acc.has(item)) next.add(item)
      }
    }
    acc = next
  }
  return acc
}

function intersectExecutables(
  arrays: ReadonlyArray<readonly string[] | undefined>,
): ReadonlySet<string> {
  const present = arrays.filter((a): a is readonly string[] => a !== undefined)
  if (present.length === 0) return new Set()
  let acc: Set<string> = new Set(present[0])
  for (let i = 1; i < present.length; i++) {
    const next = new Set<string>()
    for (const left of acc) {
      for (const right of present[i] ?? []) {
        const intersected = intersectExecutableEntry(left, right)
        if (intersected !== undefined) next.add(intersected)
      }
    }
    acc = next
  }
  return acc
}

function intersectExecutableEntry(left: string, right: string): string | undefined {
  if (left === right) return left
  const leftHasPath = hasPathSeparator(left)
  const rightHasPath = hasPathSeparator(right)
  if (leftHasPath && !rightHasPath && executableBasename(left) === right) return left
  if (!leftHasPath && rightHasPath && left === executableBasename(right)) return right
  return undefined
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\')
}

function executableBasename(value: string): string {
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return slash === -1 ? value : value.slice(slash + 1)
}

function intersectToolMatchers(
  matchers: ReadonlyArray<ToolMatcher | undefined>,
): ResolvedToolMatcher {
  const present = matchers.filter((m): m is ToolMatcher => m !== undefined)
  if (present.length === 0) return EMPTY_MATCHER

  const normalized = present.map(normalizeToolMatcher)
  let acc = normalized[0] ?? EMPTY_MATCHER
  for (let i = 1; i < normalized.length; i++) {
    const next = normalized[i]
    if (next === undefined) continue
    acc = {
      exact: new Set([...acc.exact].filter((x) => next.exact.has(x))),
      prefixes: acc.prefixes.filter((p) => next.prefixes.includes(p)),
      star: acc.star && next.star,
    }
  }
  return Object.freeze(acc)
}

function unionToolMatchers(matchers: ReadonlyArray<ToolMatcher | undefined>): ResolvedToolMatcher {
  const acc = {
    exact: new Set<string>(),
    prefixes: [] as string[],
    star: false,
  }
  for (const m of matchers) {
    if (m === undefined) continue
    const n = normalizeToolMatcher(m)
    for (const x of n.exact) acc.exact.add(x)
    for (const p of n.prefixes) {
      if (!acc.prefixes.includes(p)) acc.prefixes.push(p)
    }
    if (n.star) acc.star = true
  }
  return Object.freeze({
    exact: acc.exact,
    prefixes: Object.freeze(acc.prefixes),
    star: acc.star,
  })
}

function normalizeToolMatcher(m: ToolMatcher): ResolvedToolMatcher {
  if (Array.isArray(m)) {
    const exact = new Set<string>()
    const prefixes: string[] = []
    let star = false
    for (const id of m as readonly string[]) {
      if (id === '*') {
        star = true
      } else if (id.endsWith('.*')) {
        prefixes.push(id.slice(0, -1)) // keep the dot
      } else {
        exact.add(id)
      }
    }
    return Object.freeze({ exact, prefixes: Object.freeze(prefixes), star })
  }
  const obj = m as { exact?: readonly string[]; prefixes?: readonly string[]; star?: boolean }
  return Object.freeze({
    exact: new Set(obj.exact ?? []),
    prefixes: Object.freeze([...(obj.prefixes ?? [])]),
    star: obj.star ?? false,
  })
}

function stripProfile(permissions: AgentPermissions | undefined): AgentPermissions | undefined {
  if (permissions === undefined) return undefined
  const { profile: _profile, ...rest } = permissions
  return rest
}

function matches(matcher: ResolvedToolMatcher, id: string): boolean {
  if (matcher.star) return true
  if (matcher.exact.has(id)) return true
  for (const p of matcher.prefixes) {
    if (id.startsWith(p)) return true
  }
  return false
}

function intersectNetwork(policies: ReadonlyArray<NetworkPolicy | undefined>): NetworkPolicy {
  const present = policies.filter((p): p is NetworkPolicy => p !== undefined)
  if (present.length === 0) return 'deny'
  let acc: NetworkPolicy = present[0] ?? 'deny'
  for (let i = 1; i < present.length; i++) {
    const next = present[i]
    if (next === undefined) continue
    acc = narrowNetwork(acc, next)
  }
  return acc
}

function narrowNetwork(a: NetworkPolicy, b: NetworkPolicy): NetworkPolicy {
  if (a === 'deny' || b === 'deny') return 'deny'
  if (a === 'allow') return b
  if (b === 'allow') return a
  // Both are { allowHosts: [...] }; intersect.
  const intersected = a.allowHosts.filter((h) => b.allowHosts.includes(h))
  return { allowHosts: Object.freeze(intersected) }
}

function lastDefined<T>(arr: ReadonlyArray<T | undefined>): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== undefined) return arr[i]
  }
  return undefined
}

/**
 * Returns a `fetch` wrapper that enforces the network egress policy from a
 * resolved permission policy. Every outbound request is checked against the
 * policy before the real `fetch` is called; denied requests throw
 * `PermissionDeniedError`.
 *
 * Use this to build `BackendContext.fetch` when running an agent step that
 * declares a network policy.
 *
 * @param enforcer  Trust enforcer holding the resolved policy for the current step.
 * @param events    Optional callback to emit `permission.denied` events.
 * @param base      Base fetch implementation (defaults to `globalThis.fetch`).
 */
export function createPolicyFetch(
  enforcer: TrustEnforcer,
  events?: {
    publish: (event: {
      type: 'permission.denied'
      runId: string
      stepId: string
      dimension: PermissionDimension
      detail: string
      at: number
    }) => void
    runId: string
    stepId: string
  },
  base: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async function policyFetch(input, init) {
    if (enforcer.policy.unrestricted === true) return base(input, init)
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      // Unparseable URL — deny to be safe.
      throw new PermissionDeniedError(`network request denied: URL could not be parsed: ${url}`)
    }
    // Block cloud instance-metadata literals (e.g. 169.254.169.254) even under
    // an `allow`/allowHosts policy — reaching them is the canonical SSRF
    // credential-theft path, never a legitimate `networkEgress` target.
    if (isMetadataAddress(host)) {
      const detail = `network request to cloud-metadata address "${host}" denied`
      if (events !== undefined) {
        events.publish({
          type: 'permission.denied',
          runId: events.runId,
          stepId: events.stepId,
          dimension: 'network',
          detail,
          at: Date.now(),
        })
      }
      throw new PermissionDeniedError(detail)
    }
    const decision = enforcer.canFetch(host)
    if (!decision.allow) {
      const detail = `network request to "${host}" denied (${decision.reason})`
      if (events !== undefined) {
        events.publish({
          type: 'permission.denied',
          runId: events.runId,
          stepId: events.stepId,
          dimension: 'network',
          detail,
          at: Date.now(),
        })
      }
      throw new PermissionDeniedError(detail)
    }
    return base(input, init)
  }
}
