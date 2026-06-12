/**
 * Thin class wrapper around resolvePermissions() so the gateway can swap
 * in alternative resolution strategies (per-tenant, per-environment) in
 * future phases without changing Runner's signature.
 */

import {
  type AgentPermissions,
  type ExecutableProfileDefinition,
  type ResolvePermissionsOptions,
  type ResolvedPolicy,
  resolvePermissions,
} from '../permissions.js'

export interface PermissionResolverOptions {
  defaults?: AgentPermissions
  profiles?: Readonly<Record<string, AgentPermissions>>
  /** Operator-defined executable profile definitions referenced by `permissions.executableProfiles`. */
  executableProfiles?: Readonly<Record<string, ExecutableProfileDefinition>>
}

export class PermissionResolver {
  constructor(private readonly opts: PermissionResolverOptions = {}) {}

  /**
   * `resolveOpts` carries the operator-side unrestricted grant. It is supplied
   * only by the gateway (the trust boundary), never derived from author input,
   * so a pipeline cannot self-escalate into the bypass.
   */
  resolve(
    stepLevel?: AgentPermissions,
    resolveOpts: ResolvePermissionsOptions = {},
  ): ResolvedPolicy {
    return resolvePermissions(this.opts.defaults, stepLevel, this.opts.profiles ?? {}, {
      ...(this.opts.executableProfiles !== undefined && {
        executableProfiles: this.opts.executableProfiles,
      }),
      ...resolveOpts,
    })
  }
}
