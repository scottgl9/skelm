/**
 * Build the `AgentPermissions` declared on the coding-agent's agent step.
 *
 * This is the security surface of the package. Every grant is explicit and
 * scoped:
 *
 * - `fsRead` / `fsWrite` are scoped to the workspace path ONLY. The agent
 *   cannot read or write a single byte outside it (the native backend's
 *   `normalizePath` + `TrustEnforcer` enforce the boundary).
 * - executables are granted ONLY through named executable profiles the
 *   operator defined in config; there is no arbitrary exec. Validation
 *   profiles are always active, while PR-only profiles are withheld unless
 *   `pr.enabled` is true. An empty profile list means the agent has no
 *   executables at all (default-deny).
 * - `networkEgress` defaults to `'deny'`; it opens only to an explicit
 *   host allowlist from the profile when PR mode is enabled.
 * - tools default to the built-in file-edit + exec surface via `'*'`, which
 *   the native backend still gates per-dimension; we do NOT grant delegation,
 *   MCP servers, skills, secrets, or agentmemory.
 *
 * Nothing here can widen past the project defaults: the runtime intersects
 * these step-level grants with `defaults.permissions`, so this builder
 * declares a CEILING, not an escalation.
 */

import type { AgentPermissions, NetworkPolicy } from '@skelm/core'

import type { ProjectProfile, PullRequestConfig } from './config.js'

/**
 * Construct the step-level permissions for the implement/validate agent step.
 *
 * @param workspace absolute workspace path; the only fs root granted.
 * @param profile per-repo executable/network policy.
 * @param pr PR-opt-in config; when enabled the network allowlist is honored
 *   (a PR-capable run still needs the host the git remote / API lives on)
 *   but no new dimension is opened beyond what the profile already declares.
 */
export function buildAgentPermissions(
  workspace: string,
  profile: ProjectProfile,
  pr: PullRequestConfig,
): AgentPermissions {
  const executableProfiles = [
    ...(profile.executableProfiles ?? []),
    ...(pr.enabled === true ? (profile.prExecutableProfiles ?? []) : []),
  ]
  const network: NetworkPolicy =
    pr.enabled === true && profile.allowHosts !== undefined && profile.allowHosts.length > 0
      ? { allowHosts: [...profile.allowHosts] }
      : 'deny'

  const permissions: AgentPermissions = {
    // The native backend gates fs.read / fs.write / executable per call; '*'
    // on tools only lets the model address the built-in tools by name. It does
    // NOT bypass any dimension gate.
    allowedTools: ['*'],
    // Read and write are scoped to the workspace. No other root is granted, so
    // a path-escape attempt is denied by TrustEnforcer.canRead/canWrite.
    fsRead: [workspace],
    fsWrite: [workspace],
    networkEgress: network,
    // Delegation, MCP, skills, secrets, and agentmemory are all left
    // undefined → default-deny. The coding agent neither delegates nor talks
    // to external tool servers.
  }

  if (executableProfiles.length > 0) {
    ;(permissions as { executableProfiles?: readonly string[] }).executableProfiles = [
      ...executableProfiles,
    ]
  }
  if (profile.allowedExecutables !== undefined && profile.allowedExecutables.length > 0) {
    ;(permissions as { allowedExecutables?: readonly string[] }).allowedExecutables = [
      ...profile.allowedExecutables,
    ]
  }

  return Object.freeze(permissions)
}
