import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpClient } from '../../src/mcp/client.js'
import { createMcpHost } from '../../src/mcp/host.js'
import { TrustEnforcer, resolvePermissions } from '../../src/permissions.js'

// All shell-like tool names that requestedExecutable() should gate.
const SHELL_TOOLS = [
  'bash',
  'sh',
  'shell',
  'exec',
  'execute',
  'execute_command',
  'run_command',
  'run_shell_command',
  'terminal',
  'terminal_exec',
  'spawn',
]

vi.mock('../../src/mcp/client.js', () => {
  const MockMcpClient = vi.fn().mockImplementation(function () {
    return {
      connectHttp: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: SHELL_TOOLS.map((name) => ({
          name,
          description: `Run via ${name}`,
          inputSchema: {},
        })),
      }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      stop: vi.fn().mockResolvedValue(undefined),
    }
  })
  return { McpClient: MockMcpClient }
})

const servers = [{ id: 'shell', transport: 'http' as const, url: 'http://127.0.0.1:9200' }]

describe('MCP host — requestedExecutable covers all SHELL_TOOL_NAMES', () => {
  it.each(SHELL_TOOLS)(
    'default-deny: %s is blocked when allowedExecutables is omitted',
    async (toolName) => {
      const enforcer = new TrustEnforcer(
        resolvePermissions(undefined, {
          allowedMcpServers: ['shell'],
          allowedTools: [`shell.${toolName}`],
          // No allowedExecutables — should default-deny
        }),
      )
      const host = await createMcpHost(servers, { enforcer })

      await expect(
        host.invokeTool(`shell.${toolName}`, { command: 'cat /etc/passwd' }),
      ).rejects.toThrow(/not allowed/)

      await host.dispose()
    },
  )

  it.each(SHELL_TOOLS)('allows %s when binary is in allowedExecutables', async (toolName) => {
    // bash and sh resolve to their own name; others parse from command arg
    const binary = toolName === 'bash' || toolName === 'sh' ? toolName : 'cat'
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['shell'],
        allowedTools: [`shell.${toolName}`],
        allowedExecutables: [binary],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    const result = await host.invokeTool(`shell.${toolName}`, { command: 'cat /etc/passwd' })
    expect(result).toBeDefined()

    await host.dispose()
  })

  it('non-shell tool names bypass executable enforcement', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['shell'],
        allowedTools: ['shell.read_file'],
        // No allowedExecutables — but read_file is not a shell tool
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    // read_file is not in SHELL_TOOL_NAMES → no executable check
    // But it IS in FS_READ_NAMES — needs fsRead
    const enforcer2 = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['shell'],
        allowedTools: ['shell.search_code'],
      }),
    )
    const host2 = await createMcpHost(servers, { enforcer: enforcer2 })
    const result = await host2.invokeTool('shell.search_code', { query: 'hello' })
    expect(result).toBeDefined()

    await host.dispose()
    await host2.dispose()
  })
})
