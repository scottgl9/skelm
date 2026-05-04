/**
 * Thin class wrapper around resolvePermissions() so the gateway can swap
 * in alternative resolution strategies (per-tenant, per-environment) in
 * future phases without changing Runner's signature.
 */

import { type AgentPermissions, type ResolvedPolicy, resolvePermissions } from '../permissions.js'

export interface PermissionResolverOptions {
  defaults?: AgentPermissions
  profiles?: Readonly<Record<string, AgentPermissions>>
}

export class PermissionResolver {
  constructor(private readonly opts: PermissionResolverOptions = {}) {}

  resolve(stepLevel?: AgentPermissions): ResolvedPolicy {
    return resolvePermissions(this.opts.defaults, stepLevel, this.opts.profiles ?? {})
  }
}
