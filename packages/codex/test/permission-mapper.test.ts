import { type AgentPermissions, resolvePermissions } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import {
  CodexPermissionError,
  buildAuditEntry,
  filterIds,
  mapPermissionsToCodex,
} from '../src/permission-mapper.js'

function resolve(perms: AgentPermissions) {
  // Defaults explicit so callers can override only what they want.
  return resolvePermissions(undefined, perms)
}

describe('mapPermissionsToCodex', () => {
  it('maps empty fsWrite/fsRead to read-only sandbox', () => {
    const mapped = mapPermissionsToCodex({ policy: resolve({ fsWrite: [], fsRead: [] }) })
    expect(mapped.sandboxMode).toBe('read-only')
    expect(mapped.networkAccessEnabled).toBe(false)
    expect(mapped.workingDirectory).toBeUndefined()
    expect(mapped.additionalDirectories).toBeUndefined()
  })

  it('maps fsWrite roots to workspace-write with the first root as workingDirectory', () => {
    const mapped = mapPermissionsToCodex({
      policy: resolve({ fsWrite: ['/tmp/a', '/tmp/b', '/tmp/c'] }),
    })
    expect(mapped.sandboxMode).toBe('workspace-write')
    expect(mapped.workingDirectory).toBe('/tmp/a')
    expect(mapped.additionalDirectories).toEqual(['/tmp/b', '/tmp/c'])
  })

  it('prefers the runtime-provided workingDirectory over the first fsWrite root', () => {
    const mapped = mapPermissionsToCodex({
      policy: resolve({ fsWrite: ['/tmp/a', '/tmp/b'] }),
      workingDirectory: '/run/abc',
    })
    expect(mapped.workingDirectory).toBe('/run/abc')
    // Both fsWrite roots become extras since they differ from workingDirectory.
    expect(mapped.additionalDirectories).toEqual(['/tmp/a', '/tmp/b'])
  })

  it('elevates to danger-full-access when fsWrite: ["*"] AND no approval policy', () => {
    const mapped = mapPermissionsToCodex({ policy: resolve({ fsWrite: ['*'] }) })
    expect(mapped.sandboxMode).toBe('danger-full-access')
  })

  it('refuses fsWrite: ["*"] when an approval policy is also set', () => {
    expect(() =>
      mapPermissionsToCodex({
        policy: resolve({ fsWrite: ['*'], approval: { on: ['executable'] } }),
      }),
    ).toThrow(CodexPermissionError)
  })

  it('maps networkEgress: "deny" → networkAccessEnabled: false', () => {
    const mapped = mapPermissionsToCodex({ policy: resolve({ networkEgress: 'deny' }) })
    expect(mapped.networkAccessEnabled).toBe(false)
  })

  it('maps networkEgress: "allow" → networkAccessEnabled: true', () => {
    const mapped = mapPermissionsToCodex({ policy: resolve({ networkEgress: 'allow' }) })
    expect(mapped.networkAccessEnabled).toBe(true)
  })

  it('maps host-allowlisted networkEgress → networkAccessEnabled: true (proxy enforces hosts)', () => {
    const mapped = mapPermissionsToCodex({
      policy: resolve({ networkEgress: { allowHosts: ['example.com'] } }),
    })
    expect(mapped.networkAccessEnabled).toBe(true)
  })

  it('defaults approvalPolicy to "never" when no approval is set (sandbox is the deny)', () => {
    const mapped = mapPermissionsToCodex({ policy: resolve({ fsWrite: [] }) })
    expect(mapped.approvalPolicy).toBe('never')
  })

  it('picks "untrusted" approvalPolicy when approval covers tool/executable', () => {
    const mapped = mapPermissionsToCodex({
      policy: resolve({ fsWrite: ['/tmp/x'], approval: { on: ['executable'] } }),
    })
    expect(mapped.approvalPolicy).toBe('untrusted')
  })
})

describe('filterIds', () => {
  it('partitions requested ids by an allowlist', () => {
    const out = filterIds(['a', 'b', 'c'], new Set(['a', 'c']))
    expect(out.allowed).toEqual(['a', 'c'])
    expect(out.denied).toEqual(['b'])
  })

  it('returns empty arrays when ids is undefined', () => {
    const out = filterIds(undefined, new Set(['anything']))
    expect(out.allowed).toEqual([])
    expect(out.denied).toEqual([])
  })
})

describe('buildAuditEntry', () => {
  it('records the mapped policy and any denied items', () => {
    const policy = resolve({ fsWrite: ['/tmp/x'], allowedMcpServers: ['srv-a'] })
    const mapped = mapPermissionsToCodex({ policy })
    const entry = buildAuditEntry('run-1', 'step-1', policy, mapped, ['mcp:srv-b'])
    expect(entry.event).toBe('permission_check')
    expect(entry.details.decision).toBe('deny')
    expect(entry.details.deniedItems).toEqual(['mcp:srv-b'])
    expect(entry.details.mapped.sandboxMode).toBe('workspace-write')
    expect(entry.details.backend).toBe('codex')
  })
})
