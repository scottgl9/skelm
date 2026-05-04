import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AutoApproveGate,
  AutoDenyGate,
  EnvSecretResolver,
  NoopAuditWriter,
  PermissionResolver,
  Runner,
} from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChainAuditWriter, Gateway, SuspendApprovalGate } from '../src/index.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-enforce-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('Runner.enforcement', () => {
  it('uses safe defaults when no enforcement is supplied', () => {
    const runner = new Runner()
    expect(runner.enforcement.auditWriter).toBeInstanceOf(NoopAuditWriter)
    expect(runner.enforcement.secretResolver).toBeInstanceOf(EnvSecretResolver)
    expect(runner.enforcement.approvalGate).toBeInstanceOf(AutoApproveGate)
  })

  it('honors injected enforcement instances', () => {
    const audit = new NoopAuditWriter()
    const secrets = new EnvSecretResolver()
    const gate = new AutoDenyGate()
    const runner = new Runner({
      auditWriter: audit,
      secretResolver: secrets,
      approvalGate: gate,
    })
    expect(runner.enforcement.auditWriter).toBe(audit)
    expect(runner.enforcement.secretResolver).toBe(secrets)
    expect(runner.enforcement.approvalGate).toBe(gate)
  })
})

describe('PermissionResolver', () => {
  it('intersects step-level permissions with project defaults', () => {
    const resolver = new PermissionResolver({
      defaults: {
        allowedExecutables: ['node', 'pnpm'],
        allowedTools: [],
        allowedSkills: [],
        allowedMcpServers: [],
        fsRead: [],
        fsWrite: [],
        networkEgress: 'deny',
      },
    })
    const policy = resolver.resolve({
      allowedExecutables: ['node', 'rm'],
      allowedTools: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: [],
      fsWrite: [],
      networkEgress: 'deny',
    })
    expect(Array.from(policy.allowedExecutables)).toEqual(['node'])
  })
})

describe('Gateway.enforcement', () => {
  it('exposes resolver / writer / secret / gate after start, throws after stop', async () => {
    const gw = new Gateway({ stateDir, watchRegistries: false })
    await gw.start()
    const e = gw.enforcement
    expect(e.permissionResolver).toBeInstanceOf(PermissionResolver)
    expect(e.auditWriter).toBeInstanceOf(ChainAuditWriter)
    expect(e.secretResolver).toBeInstanceOf(EnvSecretResolver)
    expect(e.approvalGate).toBeInstanceOf(SuspendApprovalGate)
    await gw.stop()
    expect(() => gw.enforcement).toThrow(/enforcement is not available/)
  })

  it('reload(nextConfig) rebuilds the resolver with new defaults', async () => {
    const gw = new Gateway({ stateDir, watchRegistries: false })
    await gw.start()
    const r1 = gw.enforcement.permissionResolver
    await gw.reload({
      defaults: {
        permissions: {
          allowedExecutables: ['echo'],
          allowedTools: [],
          allowedSkills: [],
          allowedMcpServers: [],
          fsRead: [],
          fsWrite: [],
          networkEgress: 'deny',
        },
      },
    })
    const r2 = gw.enforcement.permissionResolver
    expect(r2).not.toBe(r1)
    await gw.stop()
  })
})
