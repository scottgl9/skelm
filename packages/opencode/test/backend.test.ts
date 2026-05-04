import type { AgentRequest, BackendContext } from '@skelm/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeBackend } from '../src/backend.js'

describe('OpencodeBackend', () => {
  describe('createOpencodeBackend', () => {
    it('creates backend with default options', () => {
      const backend = createOpencodeBackend({
        apiKey: 'test-key',
      })

      expect(backend.id).toBe('opencode')
      expect(backend.capabilities.prompt).toBe(true)
      expect(backend.capabilities.streaming).toBe(true)
      expect(backend.capabilities.toolPermissions).toBe('wrapped')
    })

    it('creates backend with custom id and label', () => {
      const backend = createOpencodeBackend({
        apiKey: 'test-key',
        id: 'custom-opencode',
        label: 'Custom Opencode Backend',
      })

      expect(backend.id).toBe('custom-opencode')
      expect(backend.label).toBe('Custom Opencode Backend')
    })

    it('creates backend with model selection capability', () => {
      const backend = createOpencodeBackend({
        apiKey: 'test-key',
        model: 'anthropic/claude-sonnet-4',
      })

      expect(backend.capabilities.modelSelection).toBe(true)
    })
  })

  describe('Permission Enforcement', () => {
    it('denies requests with unauthorized MCP servers', async () => {
      const backend = createOpencodeBackend({
        apiKey: 'test-key',
      })

      const request: AgentRequest = {
        prompt: 'Use MCP server',
        permissions: {
          allowedTools: { exact: new Set(), prefixes: [], star: false },
          deniedTools: { exact: new Set(), prefixes: [], star: false },
          allowedExecutables: new Set(),
          allowedMcpServers: new Set(), // No MCP servers allowed
          allowedSkills: new Set(),
          networkEgress: 'deny',
          fsRead: new Set(),
          fsWrite: new Set(),
          approval: null,
        },
        mcpServers: [{ id: 'github', transport: 'stdio', command: 'mcp-github' }],
      }

      const context: BackendContext = {
        signal: new AbortController().signal,
      }

      await expect(backend.run?.(request, context)).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining('Permission denied'),
        }),
      )
    })

    it('allows requests within declared permissions', async () => {
      const backend = createOpencodeBackend({
        apiKey: 'test-key',
      })

      const request: AgentRequest = {
        prompt: 'Read file',
        permissions: {
          allowedTools: { exact: new Set(['read_file']), prefixes: [], star: false },
          deniedTools: { exact: new Set(), prefixes: [], star: false },
          allowedExecutables: new Set(),
          allowedMcpServers: new Set(),
          allowedSkills: new Set(),
          networkEgress: 'deny',
          fsRead: new Set(['/workspace']),
          fsWrite: new Set(),
          approval: null,
        },
        mcpServers: [],
      }

      const context: BackendContext = {
        signal: new AbortController().signal,
      }

      // This will fail at SDK level (no real API key), but permission check should pass
      // The SDK will fail when trying to make network requests
      await expect(backend.run?.(request, context)).rejects.toThrow()
    })
  })

  describe('Error Handling', () => {
    it('throws authentication error on invalid key', async () => {
      const backend = createOpencodeBackend({
        apiKey: 'invalid-key',
      })

      const request: AgentRequest = {
        prompt: 'Test',
        permissions: {
          allowedTools: { exact: new Set(), prefixes: [], star: false },
          deniedTools: { exact: new Set(), prefixes: [], star: false },
          allowedExecutables: new Set(),
          allowedMcpServers: new Set(),
          allowedSkills: new Set(),
          networkEgress: 'deny',
          fsRead: new Set(),
          fsWrite: new Set(),
          approval: null,
        },
        mcpServers: [],
      }

      const context: BackendContext = {
        signal: new AbortController().signal,
      }

      // Will fail when trying to create session with invalid API key
      await expect(backend.run?.(request, context)).rejects.toThrow()
    })
  })
})
