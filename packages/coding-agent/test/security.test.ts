/**
 * Adversarial security tests for the coding-agent workflow.
 *
 * These assert the DECLARED permissions are default-deny and workspace-scoped,
 * and prove enforcement against the REAL `TrustEnforcer` (never a mock) on the
 * exact `ResolvedPolicy` the backend received from the runtime. The workflow
 * cannot write outside its workspace and cannot run an executable outside its
 * declared profiles — these are the package's security guarantees.
 */

import { join } from 'node:path'

import { TrustEnforcer, runPipeline } from '@skelm/core'
import { describe, expect, it } from 'vitest'

import { buildAgentPermissions } from '../src/permissions.js'
import { createCodingAgentWorkflow } from '../src/workflow.js'
import { firstCallPolicy, fixtureRepo, makeScriptedBackend, registryWith } from './helpers.js'

const WORKSPACE = '/srv/project'

describe('coding-agent declared permissions (default-deny)', () => {
  it('grants nothing privileged by default: no exec, no network, no MCP/skills/secrets/delegation', () => {
    const perms = buildAgentPermissions(WORKSPACE, {}, { enabled: false })
    expect(perms.allowedExecutables).toBeUndefined()
    expect(perms.executableProfiles).toBeUndefined()
    expect(perms.networkEgress).toBe('deny')
    expect(perms.allowedMcpServers).toBeUndefined()
    expect(perms.allowedSkills).toBeUndefined()
    expect(perms.allowedSecrets).toBeUndefined()
    // No delegation grant: the coding agent cannot trigger other privileged runs.
    expect((perms as { allowedAgents?: unknown }).allowedAgents).toBeUndefined()
  })

  it('scopes fsRead/fsWrite to the workspace only', () => {
    const perms = buildAgentPermissions(WORKSPACE, {}, { enabled: false })
    expect(perms.fsRead).toEqual([WORKSPACE])
    expect(perms.fsWrite).toEqual([WORKSPACE])
  })

  it('keeps network denied unless PR mode explicitly enables the host allowlist', () => {
    const denied = buildAgentPermissions(WORKSPACE, {}, { enabled: false })
    expect(denied.networkEgress).toBe('deny')
    const prDisabled = buildAgentPermissions(
      WORKSPACE,
      { allowHosts: ['api.github.com'] },
      { enabled: false },
    )
    expect(prDisabled.networkEgress).toBe('deny')
    const allowed = buildAgentPermissions(
      WORKSPACE,
      { allowHosts: ['api.github.com'] },
      { enabled: true },
    )
    expect(allowed.networkEgress).toEqual({ allowHosts: ['api.github.com'] })
  })

  it('withholds PR-only executable profiles unless PR mode is enabled', () => {
    const prDisabled = buildAgentPermissions(
      WORKSPACE,
      { executableProfiles: ['nodeBuild'], prExecutableProfiles: ['gitReadOnly'] },
      { enabled: false },
    )
    expect(prDisabled.executableProfiles).toEqual(['nodeBuild'])

    const allowed = buildAgentPermissions(
      WORKSPACE,
      { executableProfiles: ['nodeBuild'], prExecutableProfiles: ['gitReadOnly'] },
      { enabled: true },
    )
    expect(allowed.executableProfiles).toEqual(['nodeBuild', 'gitReadOnly'])
  })
})

describe('coding-agent enforcement (real TrustEnforcer, no mocks)', () => {
  it('CANNOT write outside the workspace; CAN write inside it', async () => {
    const backend = makeScriptedBackend()
    const wf = createCodingAgentWorkflow({
      workspace: fixtureRepo(),
      profile: { executableProfiles: ['nodeBuild'] },
    })
    const run = await runPipeline(
      wf,
      { task: 'x' },
      {
        backends: registryWith(backend),
        executableProfiles: { nodeBuild: { executables: ['node', 'pnpm'] } },
      },
    )
    expect(run.status).toBe('completed')

    // Enforce against the EXACT resolved policy the backend received.
    const enforcer = new TrustEnforcer(firstCallPolicy(backend))

    const inside = enforcer.canWrite(join(fixtureRepo(), 'src/index.js'))
    expect(inside.allow).toBe(true)

    const outside = enforcer.canWrite('/etc/passwd')
    expect(outside.allow).toBe(false)
    if (!outside.allow) {
      expect(outside.dimension).toBe('fs.write')
    }

    // A `..` traversal out of the workspace is also denied (paths normalize).
    const traversal = enforcer.canWrite(join(fixtureRepo(), '../../etc/shadow'))
    expect(traversal.allow).toBe(false)
  })

  it('CANNOT exec a binary outside the declared executable profiles', async () => {
    const backend = makeScriptedBackend()
    const wf = createCodingAgentWorkflow({
      workspace: fixtureRepo(),
      profile: { executableProfiles: ['nodeBuild'] },
    })
    const run = await runPipeline(
      wf,
      { task: 'x' },
      {
        backends: registryWith(backend),
        executableProfiles: { nodeBuild: { executables: ['node', 'pnpm'] } },
      },
    )
    expect(run.status).toBe('completed')

    const enforcer = new TrustEnforcer(firstCallPolicy(backend))
    expect(enforcer.canExec('node').allow).toBe(true)
    const rm = enforcer.canExec('rm')
    expect(rm.allow).toBe(false)
    if (!rm.allow) expect(rm.dimension).toBe('executable')
    expect(enforcer.canExec('bash').allow).toBe(false)
  })

  it('CANNOT make any network request when no host is allowed', async () => {
    const backend = makeScriptedBackend()
    const wf = createCodingAgentWorkflow({
      workspace: fixtureRepo(),
      profile: { executableProfiles: ['nodeBuild'] },
    })
    await runPipeline(
      wf,
      { task: 'x' },
      {
        backends: registryWith(backend),
        executableProfiles: { nodeBuild: { executables: ['node', 'pnpm'] } },
      },
    )
    const enforcer = new TrustEnforcer(firstCallPolicy(backend))
    expect(enforcer.canFetch('api.github.com').allow).toBe(false)
    expect(enforcer.canFetch('example.com').allow).toBe(false)
  })
})
