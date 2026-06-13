// Package trust policy. A workflow package's TRUST LEVEL is derived from the
// source it was installed from; the operator's TRUST POLICY decides which
// levels may activate without an explicit approval. An update that BROADENS the
// permission/secret/trigger surface a package requests is a flagged event that
// requires approval — the substrate never lets a package silently widen its
// reach across an update. All decisions here are advisory data; the gateway
// owns enforcement and audit.

import type { AgentPermissions, NetworkPolicy, ToolMatcher } from '../permissions.js'
import type { WorkflowPackageManifest } from './manifest.js'

/**
 * How much an installed package is trusted, derived from its install source.
 *
 * - `local`    — installed from a local directory on the operator's machine.
 * - `workspace`— a local `.tgz` tarball built from this workspace.
 * - `npm`      — a tarball or spec resolved from the public npm registry.
 * - `verified` — a registry source that carries a verified-publisher signal.
 * - `private`  — a private/internal registry source.
 */
export type PackageTrustLevel = 'local' | 'workspace' | 'npm' | 'verified' | 'private'

/** Every trust level, lowest-to-highest provenance specificity. */
export const ALL_PACKAGE_TRUST_LEVELS = [
  'local',
  'workspace',
  'npm',
  'verified',
  'private',
] as const satisfies readonly PackageTrustLevel[]

/** Hints the gateway can pass so registry origins resolve to the right level. */
export interface DerivePackageTrustOptions {
  /** True when the install source is a `.tgz`/`.tar.gz` tarball, not a directory. */
  isTarball?: boolean
  /** Registry origin the source resolved from, when a remote install is in play. */
  registryOrigin?: 'npm' | 'verified' | 'private'
}

/**
 * Derive a package's trust level from its install source string plus optional
 * origin hints. Conservative by construction: a local directory is `local`, a
 * local tarball is `workspace`, and anything that came from a registry is named
 * explicitly by the caller (which alone knows the egress origin). When a
 * registry origin is supplied it wins, since a tarball fetched from npm is npm,
 * not workspace.
 */
export function derivePackageTrustLevel(
  source: string,
  opts: DerivePackageTrustOptions = {},
): PackageTrustLevel {
  if (opts.registryOrigin !== undefined) return opts.registryOrigin
  const isTarball = opts.isTarball ?? /\.(tgz|tar\.gz)$/i.test(source)
  return isTarball ? 'workspace' : 'local'
}

/**
 * Operator-declared posture over trust levels. Default-deny: a level that is in
 * neither set is REFUSED. `allow` activates without approval; `requireApproval`
 * installs only with an explicit operator approval flag and is otherwise held
 * pending. See {@link DEFAULT_PACKAGE_TRUST_POLICY} for the conservative default.
 */
export interface PackageTrustPolicy {
  /** Levels installable/activatable with no approval. */
  allow?: readonly PackageTrustLevel[]
  /** Levels that install only with an explicit approval; pending otherwise. */
  requireApproval?: readonly PackageTrustLevel[]
}

/**
 * Conservative default: local development sources activate freely; everything
 * sourced from a registry (npm/verified/private) needs an explicit operator
 * approval. A level absent from both lists is denied outright.
 */
export const DEFAULT_PACKAGE_TRUST_POLICY: PackageTrustPolicy = Object.freeze({
  allow: Object.freeze(['local', 'workspace'] as const),
  requireApproval: Object.freeze(['npm', 'verified', 'private'] as const),
})

/** Outcome of evaluating a trust level against the policy. */
export type PackageTrustDecision = 'allow' | 'requires-approval' | 'denied'

/**
 * Evaluate a trust level against the policy. `allow` wins over `requireApproval`
 * if a level is (mis)configured into both; a level in neither set is `denied`.
 */
export function evaluatePackageTrust(
  level: PackageTrustLevel,
  policy: PackageTrustPolicy = DEFAULT_PACKAGE_TRUST_POLICY,
): PackageTrustDecision {
  if (policy.allow?.includes(level)) return 'allow'
  if (policy.requireApproval?.includes(level)) return 'requires-approval'
  return 'denied'
}

/**
 * Reviewable summary of everything a package's manifest REQUESTS across all its
 * workflow entries plus the package-level secret/integration/trigger surface.
 * Permission ceilings are unioned across workflows — the broadest reach the
 * package could be granted. Used for install/update review and expansion diffs.
 */
export interface PackagePermissionSummary {
  /** Union of every workflow's `allowedTools`, as flat string matchers. */
  tools: readonly string[]
  /** Union of every workflow's `allowedExecutables`. */
  executables: readonly string[]
  /** Union of every workflow's `executableProfiles`. */
  executableProfiles: readonly string[]
  /** Union of every workflow's `allowedMcpServers`. */
  mcpServers: readonly string[]
  /** Union of every workflow's `allowedSkills`. */
  skills: readonly string[]
  /** Union of workflow `allowedSecrets` plus manifest-declared secret names. */
  secrets: readonly string[]
  /** Union of every workflow's `fsRead` roots. */
  fsRead: readonly string[]
  /** Union of every workflow's `fsWrite` roots. */
  fsWrite: readonly string[]
  /** True when any workflow requests `networkEgress: 'allow'`. */
  networkAny: boolean
  /** Union of explicit `allowHosts` across workflows (excludes blanket allow). */
  networkHosts: readonly string[]
  /** Trigger ids the manifest offers (always disabled until enabled). */
  triggers: readonly string[]
}

function sorted(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort()
}

function matcherToList(matcher: ToolMatcher | undefined): string[] {
  if (matcher === undefined) return []
  if (Array.isArray(matcher)) return [...(matcher as readonly string[])]
  const obj = matcher as { exact?: readonly string[]; prefixes?: readonly string[]; star?: boolean }
  const out: string[] = []
  if (obj.star) out.push('*')
  for (const p of obj.prefixes ?? []) out.push(`${p}*`)
  for (const e of obj.exact ?? []) out.push(e)
  return out
}

/** Build the union permission summary from a manifest. */
export function summarizePackagePermissions(
  manifest: WorkflowPackageManifest,
): PackagePermissionSummary {
  const tools = new Set<string>()
  const executables = new Set<string>()
  const executableProfiles = new Set<string>()
  const mcpServers = new Set<string>()
  const skills = new Set<string>()
  const secrets = new Set<string>()
  const fsRead = new Set<string>()
  const fsWrite = new Set<string>()
  const networkHosts = new Set<string>()
  let networkAny = false

  const add = (set: Set<string>, values: readonly string[] | undefined): void => {
    for (const v of values ?? []) set.add(v)
  }

  for (const workflow of manifest.skelm.workflows) {
    const p: AgentPermissions | undefined = workflow.permissions
    if (p === undefined) continue
    for (const t of matcherToList(p.allowedTools)) tools.add(t)
    add(executables, p.allowedExecutables)
    add(executableProfiles, p.executableProfiles)
    add(mcpServers, p.allowedMcpServers)
    add(skills, p.allowedSkills)
    add(secrets, p.allowedSecrets)
    add(fsRead, p.fsRead)
    add(fsWrite, p.fsWrite)
    const net: NetworkPolicy | undefined = p.networkEgress
    if (net === 'allow') networkAny = true
    else if (typeof net === 'object') add(networkHosts, net.allowHosts)
  }
  for (const s of manifest.skelm.secrets ?? []) secrets.add(s.name)

  return {
    tools: sorted(tools),
    executables: sorted(executables),
    executableProfiles: sorted(executableProfiles),
    mcpServers: sorted(mcpServers),
    skills: sorted(skills),
    secrets: sorted(secrets),
    fsRead: sorted(fsRead),
    fsWrite: sorted(fsWrite),
    networkAny,
    networkHosts: sorted(networkHosts),
    triggers: sorted((manifest.skelm.triggers ?? []).map((t) => t.id)),
  }
}

/**
 * The widening detected when comparing an update's requested surface against
 * the currently-installed one. Every list holds only the NEWLY-added items;
 * `networkBroadened` is true when the update gains blanket network egress it did
 * not previously hold.
 */
export interface PackagePermissionExpansion {
  /** True when any dimension below broadened. The flag the gateway gates on. */
  expanded: boolean
  tools: readonly string[]
  executables: readonly string[]
  executableProfiles: readonly string[]
  mcpServers: readonly string[]
  skills: readonly string[]
  secrets: readonly string[]
  fsRead: readonly string[]
  fsWrite: readonly string[]
  /** Newly-blanket network egress, or newly-allowed explicit hosts. */
  networkBroadened: boolean
  networkHosts: readonly string[]
  /** Triggers offered by the update that the prior version did not offer. */
  triggers: readonly string[]
}

function added(next: readonly string[], prev: readonly string[]): readonly string[] {
  const before = new Set(prev)
  return next.filter((v) => !before.has(v))
}

/**
 * Diff two permission summaries (old → new) and flag any expansion. Only
 * widening counts: a removed permission, host, or trigger is never flagged.
 * Gaining blanket network egress always flags even when the prior version
 * already listed hosts, because `allow` is strictly broader than any host list.
 */
export function diffPackagePermissions(
  previous: PackagePermissionSummary,
  next: PackagePermissionSummary,
): PackagePermissionExpansion {
  const tools = added(next.tools, previous.tools)
  const executables = added(next.executables, previous.executables)
  const executableProfiles = added(next.executableProfiles, previous.executableProfiles)
  const mcpServers = added(next.mcpServers, previous.mcpServers)
  const skills = added(next.skills, previous.skills)
  const secrets = added(next.secrets, previous.secrets)
  const fsRead = added(next.fsRead, previous.fsRead)
  const fsWrite = added(next.fsWrite, previous.fsWrite)
  const networkHosts = next.networkAny ? [] : added(next.networkHosts, previous.networkHosts)
  const networkBroadened = (next.networkAny && !previous.networkAny) || networkHosts.length > 0
  const triggers = added(next.triggers, previous.triggers)

  const expanded =
    tools.length > 0 ||
    executables.length > 0 ||
    executableProfiles.length > 0 ||
    mcpServers.length > 0 ||
    skills.length > 0 ||
    secrets.length > 0 ||
    fsRead.length > 0 ||
    fsWrite.length > 0 ||
    networkBroadened ||
    triggers.length > 0

  return {
    expanded,
    tools,
    executables,
    executableProfiles,
    mcpServers,
    skills,
    secrets,
    fsRead,
    fsWrite,
    networkBroadened,
    networkHosts,
    triggers,
  }
}
