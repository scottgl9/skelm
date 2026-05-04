import type { NetworkPolicy, ResolvedPolicy, ResolvedToolMatcher } from '@skelm/core'

/**
 * Permission configuration matching opencode's permission system
 */
export interface OpencodePermissionConfig {
  edit?: 'allow' | 'ask' | 'deny'
  bash?: 'allow' | 'ask' | 'deny'
  read?: 'allow' | 'ask' | 'deny'
  glob?: 'allow' | 'ask' | 'deny'
  grep?: 'allow' | 'ask' | 'deny'
  list?: 'allow' | 'ask' | 'deny'
  task?: 'allow' | 'ask' | 'deny' | Record<string, 'allow' | 'ask' | 'deny'>
  external?: Record<string, 'allow' | 'ask' | 'deny'>
}

/**
 * Mapped permissions for skelm's AgentPermissions
 */
export interface MappedPermissions {
  allowedTools?: string[]
  allowedExecutables?: string[]
  allowedMcpServers?: string[]
  allowedSkills?: string[]
  fsRead?: string[]
  fsWrite?: string[]
}

/**
 * Check if a ResolvedToolMatcher allows a specific tool
 */
function toolIsAllowed(matcher: ResolvedToolMatcher, toolId: string): boolean {
  if (matcher.star) return true
  if (matcher.exact.has(toolId)) return true
  return matcher.prefixes.some((prefix) => toolId.startsWith(prefix))
}

/**
 * Map skelm's ResolvedPolicy to opencode's permission configuration
 *
 * This is critical for enforcement - skelm validates permissions BEFORE
 * forwarding to opencode, ensuring we maintain control over execution.
 */
export function mapSkelmPermissionsToOpencode(
  skelmPermissions: ResolvedPolicy,
): OpencodePermissionConfig {
  const opencodePerms: OpencodePermissionConfig = {}

  // Map file edit permissions (fsWrite)
  if (skelmPermissions.fsWrite.size > 0) {
    // If fsWrite has any paths, allow edits
    opencodePerms.edit = 'allow'
  } else {
    // No fsWrite paths = deny edits
    opencodePerms.edit = 'deny'
  }

  // Map bash/executable permissions
  if (skelmPermissions.allowedExecutables.size > 0) {
    // Specific executables allowed
    opencodePerms.bash = 'ask' // Ask for approval for specific commands
  } else if (skelmPermissions.allowedExecutables.size === 0) {
    // Explicitly denied
    opencodePerms.bash = 'deny'
  }

  // Map MCP server permissions to external
  if (skelmPermissions.allowedMcpServers.size > 0) {
    opencodePerms.external = {}
    for (const mcpId of skelmPermissions.allowedMcpServers) {
      opencodePerms.external[`mcp_${mcpId}`] = 'allow'
    }
  }

  // Map skill permissions to read/glob/grep/list
  if (skelmPermissions.allowedSkills.size > 0) {
    for (const skill of skelmPermissions.allowedSkills) {
      // Map common skills to opencode permissions
      if (skill.includes('read') || skill.includes('readonly')) {
        opencodePerms.read = 'allow'
        opencodePerms.glob = 'allow'
        opencodePerms.grep = 'allow'
        opencodePerms.list = 'allow'
      }
      if (skill.includes('write') || skill.includes('edit')) {
        opencodePerms.edit = 'allow'
      }
      if (skill.includes('bash') || skill.includes('shell')) {
        opencodePerms.bash = 'ask'
      }
    }
  }

  // Network egress mapping (opencode doesn't have direct network permissions)
  // This is enforced at skelm layer via tool restrictions
  if (
    typeof skelmPermissions.networkEgress === 'object' &&
    skelmPermissions.networkEgress.allowHosts
  ) {
    // We can't directly map this to opencode permissions
    // Enforcement happens at skelm layer before forwarding
    if (skelmPermissions.networkEgress.allowHosts.length === 0) {
      // No network access allowed - this is a skelm-layer enforcement
    }
  }

  // Default permissions for unspecified items
  // Default-deny policy: everything not explicitly allowed is denied
  if (opencodePerms.edit === undefined) {
    opencodePerms.edit = 'deny'
  }
  if (opencodePerms.bash === undefined) {
    opencodePerms.bash = 'deny'
  }
  if (opencodePerms.read === undefined) {
    opencodePerms.read = 'allow' // Allow reads by default for coding agents
  }

  return opencodePerms
}

/**
 * Map opencode permissions back to skelm's permission structure
 * (for audit logging and status reporting)
 */
export function mapOpencodePermissionsToSkelm(
  opencodePerms: OpencodePermissionConfig,
): MappedPermissions {
  const mapped: MappedPermissions = {}

  // Map edit to fsWrite
  if (opencodePerms.edit === 'allow') {
    mapped.fsWrite = ['*'] // Wildcard for all files
  } else if (opencodePerms.edit === 'deny') {
    mapped.fsWrite = []
  }

  // Map bash to allowedExecutables
  if (opencodePerms.bash === 'allow') {
    mapped.allowedExecutables = ['*']
  } else if (opencodePerms.bash === 'deny') {
    mapped.allowedExecutables = []
  }

  // Map external to allowedMcpServers
  if (opencodePerms.external) {
    const mcpServers: string[] = []
    for (const key of Object.keys(opencodePerms.external)) {
      if (key.startsWith('mcp_') && opencodePerms.external?.[key] === 'allow') {
        mcpServers.push(key.replace('mcp_', ''))
      }
    }
    if (mcpServers.length > 0) {
      mapped.allowedMcpServers = mcpServers
    }
  }

  // Map read/glob/grep/list to allowedTools/skills
  if (opencodePerms.read === 'allow' || opencodePerms.glob === 'allow') {
    mapped.allowedSkills = ['filesystem-readonly']
  }

  return mapped
}

/**
 * Validate that requested tools/executables/MCPs are within the declared policy
 * Returns true if the request is allowed, false if it should be denied
 */
export function validatePermissions(
  policy: ResolvedPolicy,
  requested: { tools?: string[]; executables?: string[]; mcpServers?: string[] },
): { allowed: boolean; denied: string[] } {
  const denied: string[] = []

  // Check executable requests
  if (requested.executables) {
    for (const exec of requested.executables) {
      if (!policy.allowedExecutables.has(exec)) {
        denied.push(`executable:${exec}`)
      }
    }
  }

  // Check MCP server requests
  if (requested.mcpServers) {
    for (const mcp of requested.mcpServers) {
      if (!policy.allowedMcpServers.has(mcp)) {
        denied.push(`mcp:${mcp}`)
      }
    }
  }

  // Check tool requests
  if (requested.tools) {
    for (const tool of requested.tools) {
      if (!toolIsAllowed(policy.allowedTools, tool)) {
        denied.push(`tool:${tool}`)
      }
    }
  }

  return {
    allowed: denied.length === 0,
    denied,
  }
}

/**
 * Build audit log entry for permission decisions
 */
export function buildPermissionAuditEntry(
  runId: string,
  stepId: string,
  policy: ResolvedPolicy,
  result: { allowed: boolean; denied: string[] },
): Record<string, unknown> {
  return {
    runId,
    stepId,
    timestamp: new Date().toISOString(),
    event: 'permission_check',
    details: {
      declaredPermissions: {
        allowedTools: policy.allowedTools,
        allowedExecutables: Array.from(policy.allowedExecutables),
        allowedMcpServers: Array.from(policy.allowedMcpServers),
        allowedSkills: Array.from(policy.allowedSkills),
        fsRead: Array.from(policy.fsRead),
        fsWrite: Array.from(policy.fsWrite),
      },
      decision: result.allowed ? 'allow' : 'deny',
      deniedItems: result.denied,
      backend: 'opencode',
    },
  }
}
