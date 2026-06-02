import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpClient } from '../../src/mcp/client.js'
import { createMcpHost } from '../../src/mcp/host.js'
import { TrustEnforcer, resolvePermissions } from '../../src/permissions.js'

// Mock McpClient so we can simulate tool calls without spawning real processes.
vi.mock('../../src/mcp/client.js', () => {
  const MockMcpClient = vi.fn().mockImplementation(function () {
    return {
      connectHttp: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          { name: 'read_file', description: 'Read a file', inputSchema: {} },
          { name: 'read_text_file', description: 'Read a text file', inputSchema: {} },
          { name: 'read_media_file', description: 'Read a media file', inputSchema: {} },
          { name: 'write_file', description: 'Write a file', inputSchema: {} },
          { name: 'list_directory', description: 'List a dir', inputSchema: {} },
          { name: 'create_file', description: 'Create a file', inputSchema: {} },
          { name: 'move_file', description: 'Move a file', inputSchema: {} },
          { name: 'copy_file', description: 'Copy a file', inputSchema: {} },
        ],
      }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      stop: vi.fn().mockResolvedValue(undefined),
    }
  })
  return { McpClient: MockMcpClient }
})

describe('MCP host — canRead/canWrite enforcement on filesystem tool calls', () => {
  const servers = [{ id: 'fs', transport: 'http' as const, url: 'http://127.0.0.1:9100' }]

  it('default-deny: read_file is denied when fsRead is omitted', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.read_file'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    await expect(host.invokeTool('fs.read_file', { path: '/etc/passwd' })).rejects.toThrow(
      /read access.*which is not allowed/,
    )

    await host.dispose()
  })

  it('default-deny: write_file is denied when fsWrite is omitted', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.write_file'],
        fsRead: ['./'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    await expect(host.invokeTool('fs.write_file', { path: '/tmp/evil.txt' })).rejects.toThrow(
      /write access.*which is not allowed/,
    )

    await host.dispose()
  })

  it('explicit-deny: read outside fsRead roots is denied', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.read_file'],
        fsRead: ['/project/'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    await expect(host.invokeTool('fs.read_file', { path: '/etc/passwd' })).rejects.toThrow(
      /read access.*which is not allowed/,
    )

    await host.dispose()
  })

  it('allows read when path is within fsRead root', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.read_file'],
        fsRead: ['/project/'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    // Should not throw — path is under the allowed root
    const result = await host.invokeTool('fs.read_file', { path: '/project/src/main.ts' })
    expect(result).toBeDefined()

    await host.dispose()
  })

  it('allows write when path is within fsWrite root', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.write_file'],
        fsRead: ['/project/'],
        fsWrite: ['/project/'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    const result = await host.invokeTool('fs.write_file', { path: '/project/output.txt' })
    expect(result).toBeDefined()

    await host.dispose()
  })

  it('allows write to /tmp when fsWrite includes /tmp', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.create_file'],
        fsRead: ['./'],
        fsWrite: ['/tmp/'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    const result = await host.invokeTool('fs.create_file', { path: '/tmp/output.txt' })
    expect(result).toBeDefined()

    await host.dispose()
  })

  // Regression: @modelcontextprotocol/server-filesystem's current read tool is
  // `read_text_file` (renamed from `read_file`). It must be enforced exactly
  // like `read_file`, or an agent reads any path the server can reach,
  // escaping fsRead. (Previously absent from FS_READ_NAMES → silent bypass.)
  it('default-deny: read_text_file is denied when fsRead is omitted', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.read_text_file'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    await expect(host.invokeTool('fs.read_text_file', { path: '/etc/passwd' })).rejects.toThrow(
      /read access.*which is not allowed/,
    )

    await host.dispose()
  })

  it('explicit-deny: read_text_file outside fsRead roots is denied', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.read_text_file'],
        fsRead: ['/project/'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    await expect(host.invokeTool('fs.read_text_file', { path: '/etc/passwd' })).rejects.toThrow(
      /read access.*which is not allowed/,
    )

    await host.dispose()
  })

  it('allows read_text_file when path is within fsRead root', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.read_text_file'],
        fsRead: ['/project/'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    const result = await host.invokeTool('fs.read_text_file', { path: '/project/src/main.ts' })
    expect(result).toBeDefined()

    await host.dispose()
  })

  it('default-deny: read_media_file is denied when fsRead is omitted', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.read_media_file'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    await expect(host.invokeTool('fs.read_media_file', { path: '/etc/shadow' })).rejects.toThrow(
      /read access.*which is not allowed/,
    )

    await host.dispose()
  })

  // Regression: move_file/copy_file/rename take a SOURCE and a DESTINATION.
  // The single-path extraction only checked the source, so the destination —
  // which the operation writes — escaped fsWrite. An agent allowed to write
  // only inside /project could move_file source=/project/x destination=
  // /etc/cron.d/evil and write outside the allowlist. (Same class as #263.)
  it('explicit-deny: move_file destination outside fsWrite is denied (source allowed)', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.move_file'],
        fsRead: ['/project/'],
        fsWrite: ['/project/'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    await expect(
      host.invokeTool('fs.move_file', {
        source: '/project/data.txt', // inside fsWrite — passes the source check
        destination: '/etc/cron.d/evil', // outside fsWrite — must be denied
      }),
    ).rejects.toThrow(/write access to "\/etc\/cron\.d\/evil".*which is not allowed/)

    await host.dispose()
  })

  it('explicit-deny: copy_file destination outside fsWrite is denied', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.copy_file'],
        fsRead: ['/project/'],
        fsWrite: ['/project/'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    await expect(
      host.invokeTool('fs.copy_file', {
        source: '/project/a',
        destination: '/root/.ssh/authorized_keys',
      }),
    ).rejects.toThrow(/write access to "\/root\/.ssh\/authorized_keys".*which is not allowed/)

    await host.dispose()
  })

  it('allows move_file when BOTH source and destination are within fsWrite', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.move_file'],
        fsRead: ['/project/'],
        fsWrite: ['/project/'],
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    const result = await host.invokeTool('fs.move_file', {
      source: '/project/a.txt',
      destination: '/project/sub/b.txt',
    })
    expect(result).toBeDefined()

    await host.dispose()
  })

  it('non-filesystem tool names bypass fs enforcement entirely', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions(undefined, {
        allowedMcpServers: ['fs'],
        allowedTools: ['fs.search_code'],
        // No fsRead declared — but should not fire for unknown tool names
      }),
    )
    const host = await createMcpHost(servers, { enforcer })

    // 'search_code' is not in FS_READ_NAMES or FS_WRITE_NAMES → no path check
    const result = await host.invokeTool('fs.search_code', { query: 'hello' })
    expect(result).toBeDefined()

    await host.dispose()
  })
})
