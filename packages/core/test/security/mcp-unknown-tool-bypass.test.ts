import { describe, expect, it, vi } from 'vitest'
import { PermissionDeniedError } from '../../src/errors.js'
import { createMcpHost } from '../../src/mcp/host.js'
import { TrustEnforcer, resolvePermissions } from '../../src/permissions.js'

// Adversarial coverage for the fs/exec bypass via UNRECOGNISED MCP tool names.
//
// Pre-fix, the host only ran the fs/write and executable sub-checks for a
// hardcoded set of tool names, so an MCP server exposing a write/shell tool
// under any other name (put_object, apply_patch, a custom runner) skipped
// fsWrite/allowedExecutables entirely — gated only by canCallTool. The fix is
// fail-closed by ARGUMENT SHAPE: an unrecognised tool's path args are treated as
// writes, and an `argv` array is exec-checked. Recognised read tools keep their
// read classification so normal reads aren't over-gated.
vi.mock('../../src/mcp/client.js', () => {
  const MockMcpClient = vi.fn().mockImplementation(function () {
    return {
      connectHttp: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      stop: vi.fn().mockResolvedValue(undefined),
    }
  })
  return { McpClient: MockMcpClient }
})

const servers = [{ id: 'fs', transport: 'http' as const, url: 'http://127.0.0.1:9100' }]

// allowedTools is broad (`fs.*`) — the bypass only matters when the tool
// allowlist permits the call but fsWrite/allowedExecutables are narrow.
function enforcer(extra: Record<string, unknown>): TrustEnforcer {
  return new TrustEnforcer(
    resolvePermissions(undefined, {
      allowedMcpServers: ['fs'],
      allowedTools: ['fs.*'],
      ...extra,
    }),
  )
}

describe('MCP host — unrecognised tool names cannot bypass fs/exec', () => {
  it('an unknown-named tool writing outside fsWrite is denied (fail-closed write)', async () => {
    const host = await createMcpHost(servers, { enforcer: enforcer({ fsWrite: ['/sandbox'] }) })
    await expect(host.invokeTool('fs.put_object', { path: '/etc/passwd' })).rejects.toThrow(
      PermissionDeniedError,
    )
    await host.dispose()
  })

  it('an unknown-named tool with a destination field outside fsWrite is denied', async () => {
    const host = await createMcpHost(servers, { enforcer: enforcer({ fsWrite: ['/sandbox'] }) })
    await expect(
      host.invokeTool('fs.sync_object', { destination: '/etc/cron.d/payload' }),
    ).rejects.toThrow(PermissionDeniedError)
    await host.dispose()
  })

  it('an unknown-named tool spawning via argv is gated by allowedExecutables', async () => {
    const host = await createMcpHost(servers, {
      enforcer: enforcer({ fsWrite: ['/sandbox'], allowedExecutables: ['node'] }),
    })
    await expect(host.invokeTool('fs.run_task', { argv: ['rm', '-rf', '/'] })).rejects.toThrow(
      /executable "rm".*not allowed/,
    )
    await host.dispose()
  })

  it('an unknown-named tool writing inside fsWrite is allowed (no false-deny when granted)', async () => {
    const host = await createMcpHost(servers, { enforcer: enforcer({ fsWrite: ['/sandbox'] }) })
    const result = await host.invokeTool('fs.put_object', { path: '/sandbox/out.bin' })
    expect(result.content).toBeDefined()
    await host.dispose()
  })

  it('a recognised read tool keeps read classification (not over-gated as a write)', async () => {
    // fsRead granted, fsWrite empty: a known read must still succeed — proving
    // the fail-closed write treatment is scoped to UNRECOGNISED names only.
    const host = await createMcpHost(servers, { enforcer: enforcer({ fsRead: ['/data'] }) })
    const result = await host.invokeTool('fs.read_file', { path: '/data/notes.txt' })
    expect(result.content).toBeDefined()
    await host.dispose()
  })
})
