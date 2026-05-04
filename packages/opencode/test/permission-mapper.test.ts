import type { ResolvedPolicy } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import {
  buildPermissionAuditEntry,
  mapOpencodePermissionsToSkelm,
  mapSkelmPermissionsToOpencode,
  validatePermissions,
} from '../src/permission-mapper.js'

describe('Permission Mapper', () => {
  describe('mapSkelmPermissionsToOpencode', () => {
    it('maps read-only permissions correctly', () => {
      const skelmPerms: ResolvedPolicy = {
        allowedTools: { exact: new Set(), prefixes: [], star: false },
        deniedTools: { exact: new Set(), prefixes: [], star: false },
        allowedExecutables: new Set(),
        allowedMcpServers: new Set(),
        allowedSkills: new Set(['filesystem-readonly']),
        networkEgress: 'deny',
        fsRead: new Set(['/workspace']),
        fsWrite: new Set(),
        approval: null,
      }

      const result = mapSkelmPermissionsToOpencode(skelmPerms)

      expect(result.read).toBe('allow')
      expect(result.edit).toBe('deny')
      expect(result.bash).toBe('deny')
    })

    it('maps full access permissions correctly', () => {
      const skelmPerms: ResolvedPolicy = {
        allowedTools: { exact: new Set(['*']), prefixes: [], star: true },
        deniedTools: { exact: new Set(), prefixes: [], star: false },
        allowedExecutables: new Set(['*']),
        allowedMcpServers: new Set(['github']),
        allowedSkills: new Set(['filesystem-full', 'bash']),
        networkEgress: 'allow',
        fsRead: new Set(['/workspace']),
        fsWrite: new Set(['/workspace']),
        approval: null,
      }

      const result = mapSkelmPermissionsToOpencode(skelmPerms)

      expect(result.edit).toBe('allow')
      expect(result.bash).toBe('ask')
      expect(result.read).toBe('allow')
      expect(result.external?.['mcp_github']).toBe('allow')
    })

    it('maps restricted executable permissions', () => {
      const skelmPerms: ResolvedPolicy = {
        allowedTools: { exact: new Set(), prefixes: [], star: false },
        deniedTools: { exact: new Set(), prefixes: [], star: false },
        allowedExecutables: new Set(['git', 'npm']),
        allowedMcpServers: new Set(),
        allowedSkills: new Set(),
        networkEgress: 'deny',
        fsRead: new Set(['/workspace']),
        fsWrite: new Set(),
        approval: null,
      }

      const result = mapSkelmPermissionsToOpencode(skelmPerms)

      expect(result.bash).toBe('ask')
      expect(result.edit).toBe('deny')
    })

    it('defaults to deny for unspecified permissions', () => {
      const skelmPerms: ResolvedPolicy = {
        allowedTools: { exact: new Set(), prefixes: [], star: false },
        deniedTools: { exact: new Set(), prefixes: [], star: false },
        allowedExecutables: new Set(),
        allowedMcpServers: new Set(),
        allowedSkills: new Set(),
        networkEgress: 'deny',
        fsRead: new Set(),
        fsWrite: new Set(),
        approval: null,
      }

      const result = mapSkelmPermissionsToOpencode(skelmPerms)

      expect(result.edit).toBe('deny')
      expect(result.bash).toBe('deny')
      expect(result.read).toBe('allow') // Default allow for reads
    })

    it('maps MCP server permissions to external', () => {
      const skelmPerms: ResolvedPolicy = {
        allowedTools: { exact: new Set(), prefixes: [], star: false },
        deniedTools: { exact: new Set(), prefixes: [], star: false },
        allowedExecutables: new Set(),
        allowedMcpServers: new Set(['github', 'slack']),
        allowedSkills: new Set(),
        networkEgress: 'deny',
        fsRead: new Set(),
        fsWrite: new Set(),
        approval: null,
      }

      const result = mapSkelmPermissionsToOpencode(skelmPerms)

      expect(result.external).toBeDefined()
      expect(result.external?.['mcp_github']).toBe('allow')
      expect(result.external?.['mcp_slack']).toBe('allow')
    })
  })

  describe('mapOpencodePermissionsToSkelm', () => {
    it('maps opencode allow to skelm wildcards', () => {
      const opencodePerms = {
        edit: 'allow',
        bash: 'allow',
        read: 'allow',
      }

      const result = mapOpencodePermissionsToSkelm(opencodePerms)

      expect(result.fsWrite).toEqual(['*'])
      expect(result.allowedExecutables).toEqual(['*'])
      expect(result.allowedSkills).toEqual(['filesystem-readonly'])
    })

    it('maps opencode deny to skelm empty arrays', () => {
      const opencodePerms = {
        edit: 'deny',
        bash: 'deny',
        read: 'allow',
      }

      const result = mapOpencodePermissionsToSkelm(opencodePerms)

      expect(result.fsWrite).toEqual([])
      expect(result.allowedExecutables).toEqual([])
    })

    it('maps external permissions to MCP servers', () => {
      const opencodePerms = {
        external: {
          mcp_github: 'allow',
          mcp_slack: 'deny',
        },
      }

      const result = mapOpencodePermissionsToSkelm(opencodePerms)

      expect(result.allowedMcpServers).toEqual(['github'])
    })
  })

  describe('validatePermissions', () => {
    it('allows requests within declared permissions', () => {
      const declared: ResolvedPolicy = {
        allowedTools: { exact: new Set(['read_file', 'write_file']), prefixes: [], star: false },
        deniedTools: { exact: new Set(), prefixes: [], star: false },
        allowedExecutables: new Set(['git']),
        allowedMcpServers: new Set(['github']),
        allowedSkills: new Set(),
        networkEgress: 'deny',
        fsRead: new Set(['/workspace']),
        fsWrite: new Set(['/workspace']),
        approval: null,
      }

      const requested = {
        tools: ['read_file', 'write_file'],
        executables: ['git'],
        mcpServers: ['github'],
      }

      const result = validatePermissions(declared, requested)

      expect(result.allowed).toBe(true)
      expect(result.denied).toHaveLength(0)
    })

    it('denies requests outside declared permissions', () => {
      const declared: ResolvedPolicy = {
        allowedTools: { exact: new Set(['read_file']), prefixes: [], star: false },
        deniedTools: { exact: new Set(), prefixes: [], star: false },
        allowedExecutables: new Set(),
        allowedMcpServers: new Set(),
        allowedSkills: new Set(),
        networkEgress: 'deny',
        fsRead: new Set(['/workspace']),
        fsWrite: new Set(),
        approval: null,
      }

      const requested = {
        tools: ['read_file', 'write_file', 'delete_file'],
        executables: ['bash'],
        mcpServers: ['github'],
      }

      const result = validatePermissions(declared, requested)

      expect(result.allowed).toBe(false)
      expect(result.denied).toContain('tool:write_file')
      expect(result.denied).toContain('tool:delete_file')
      expect(result.denied).toContain('executable:bash')
      expect(result.denied).toContain('mcp:github')
    })

    it('allows empty requests', () => {
      const declared: ResolvedPolicy = {
        allowedTools: { exact: new Set(), prefixes: [], star: false },
        deniedTools: { exact: new Set(), prefixes: [], star: false },
        allowedExecutables: new Set(),
        allowedMcpServers: new Set(),
        allowedSkills: new Set(),
        networkEgress: 'deny',
        fsRead: new Set(),
        fsWrite: new Set(),
        approval: null,
      }

      const requested = {
        tools: [],
        executables: [],
        mcpServers: [],
      }

      const result = validatePermissions(declared, requested)

      expect(result.allowed).toBe(true)
      expect(result.denied).toHaveLength(0)
    })
  })

  describe('buildPermissionAuditEntry', () => {
    it('builds correct audit entry structure', () => {
      const runId = 'run_abc123'
      const stepId = 'agent_step_1'
      const permissions: ResolvedPolicy = {
        allowedTools: { exact: new Set(['read_file']), prefixes: [], star: false },
        deniedTools: { exact: new Set(), prefixes: [], star: false },
        allowedExecutables: new Set(['git']),
        allowedMcpServers: new Set(['github']),
        allowedSkills: new Set(),
        networkEgress: 'deny',
        fsRead: new Set(['/workspace']),
        fsWrite: new Set(),
        approval: null,
      }
      const result = { allowed: false, denied: ['tool:write_file', 'executable:bash'] }

      const entry = buildPermissionAuditEntry(runId, stepId, permissions, result)

      expect(entry.runId).toBe(runId)
      expect(entry.stepId).toBe(stepId)
      expect(entry.event).toBe('permission_check')
      expect(entry.details.decision).toBe('deny')
      expect(entry.details.deniedItems).toEqual(['tool:write_file', 'executable:bash'])
      expect(entry.details.backend).toBe('opencode')
    })
  })
})
