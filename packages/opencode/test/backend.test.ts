import { resolvePermissions } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { createOpencodeBackend } from '../src/backend.js'

describe('OpencodeBackend', () => {
  describe('createOpencodeBackend', () => {
    it('creates backend with default options', () => {
      const backend = createOpencodeBackend({})

      expect(backend.id).toBe('opencode')
      expect(backend.capabilities.prompt).toBe(false)
      expect(backend.capabilities.streaming).toBe(true)
      // Opencode manages its own permissions at the process level
      expect(backend.capabilities.toolPermissions).toBe('native')
    })

    it('creates backend with custom id and label', () => {
      const backend = createOpencodeBackend({
        id: 'custom-opencode',
        label: 'Custom Opencode Backend',
      })

      expect(backend.id).toBe('custom-opencode')
      expect(backend.label).toBe('Custom Opencode Backend')
    })

    it('creates backend with model selection capability when model is set', () => {
      const backend = createOpencodeBackend({
        model: 'llamacpp/qwen36',
      })
      expect(backend.capabilities.modelSelection).toBe(true)
    })

    it('has no model selection capability when model is unset', () => {
      const backend = createOpencodeBackend({})
      expect(backend.capabilities.modelSelection).toBe(false)
    })

    it('exposes run() method', () => {
      const backend = createOpencodeBackend({})
      expect(typeof backend.run).toBe('function')
    })
  })

  describe('capability flags', () => {
    it('reports sessionLifecycle: true', () => {
      expect(createOpencodeBackend({}).capabilities.sessionLifecycle).toBe(true)
    })

    it('reports mcp: true', () => {
      expect(createOpencodeBackend({}).capabilities.mcp).toBe(true)
    })

    it('reports skills: true', () => {
      expect(createOpencodeBackend({}).capabilities.skills).toBe(true)
    })
  })

  describe('filesystem MCP permissions', () => {
    it('refuses to forward filesystem MCP roots outside fsRead/fsWrite', async () => {
      const backend = createOpencodeBackend({})
      const declaredPermissions = {
        allowedTools: ['*'],
        allowedMcpServers: ['fs-mcp'],
        fsRead: ['/tmp/some-other-root'],
        fsWrite: [],
        networkEgress: 'deny' as const,
        allowedExecutables: [],
        allowedSkills: [],
      }
      await expect(
        backend.run?.(
          {
            prompt: 'read secret',
            mcpServers: [
              {
                id: 'fs-mcp',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/skelm-mcp-fs-root'],
              },
            ],
          },
          {
            signal: new AbortController().signal,
            permissions: resolvePermissions(
              {
                allowedTools: ['*'],
                allowedMcpServers: ['fs-mcp'],
                fsRead: ['/'],
                fsWrite: [],
                networkEgress: 'deny',
                allowedExecutables: [],
                allowedSkills: [],
              },
              declaredPermissions,
            ),
            declaredPermissions,
          },
        ),
      ).rejects.toThrow(/mcp:fs-mcp:fs-root:\/tmp\/skelm-mcp-fs-root/)
    })

    it('allows filesystem MCP roots covered by fsRead or fsWrite', async () => {
      const backend = createOpencodeBackend({})
      await expect(
        backend.run?.(
          {
            prompt: 'read allowed',
            mcpServers: [
              {
                id: 'fs-mcp',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/skelm-mcp-fs-root'],
              },
            ],
          },
          {
            signal: AbortSignal.timeout(1),
            permissions: resolvePermissions(undefined, {
              allowedTools: ['*'],
              allowedMcpServers: ['fs-mcp'],
              fsRead: ['/tmp/skelm-mcp-fs-root'],
              fsWrite: [],
              networkEgress: 'deny',
              allowedExecutables: [],
              allowedSkills: [],
            }),
          },
        ),
      ).rejects.not.toThrow(/fs-root/)
    })
  })
})
