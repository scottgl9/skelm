import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from './backend.js'
import { agent, pipeline } from './builders.js'
import { TrustEnforcer, resolvePermissions } from './permissions.js'
import { runPipeline } from './runner.js'

describe('resolvePermissions — default-deny', () => {
  it('returns empty allow-lists when nothing is declared', () => {
    const policy = resolvePermissions(undefined, undefined)
    expect(policy.allowedExecutables.size).toBe(0)
    expect(policy.allowedMcpServers.size).toBe(0)
    expect(policy.allowedSkills.size).toBe(0)
    expect(policy.fsRead.size).toBe(0)
    expect(policy.fsWrite.size).toBe(0)
    expect(policy.networkEgress).toBe('deny')
    expect(policy.allowedTools.exact.size).toBe(0)
    expect(policy.allowedTools.star).toBe(false)
  })

  it('intersects allow-lists; step cannot widen project defaults', () => {
    const policy = resolvePermissions(
      { allowedExecutables: ['rg', 'git'] },
      { allowedExecutables: ['rg', 'curl'] },
    )
    expect([...policy.allowedExecutables].sort()).toEqual(['rg'])
  })

  it('omitted step field does not widen the default', () => {
    const policy = resolvePermissions(
      { allowedExecutables: ['rg'] },
      {}, // omit
    )
    expect([...policy.allowedExecutables]).toEqual(['rg'])
  })

  it('network: any deny in either layer wins', () => {
    expect(
      resolvePermissions({ networkEgress: { allowHosts: ['a', 'b'] } }, { networkEgress: 'deny' })
        .networkEgress,
    ).toBe('deny')
  })

  it('network: allowHosts intersect', () => {
    const policy = resolvePermissions(
      { networkEgress: { allowHosts: ['a', 'b', 'c'] } },
      { networkEgress: { allowHosts: ['b', 'c', 'd'] } },
    )
    expect(policy.networkEgress).toEqual({ allowHosts: ['b', 'c'] })
  })

  it('applies named permission profiles before step-level narrowing', () => {
    const policy = resolvePermissions(
      { allowedExecutables: ['rg', 'git'] },
      { profile: 'readonly', allowedExecutables: ['rg', 'curl'] },
      { readonly: { allowedExecutables: ['rg', 'git', 'bash'] } },
    )
    expect([...policy.allowedExecutables].sort()).toEqual(['rg'])
  })

  it('throws when a referenced permission profile is missing', () => {
    expect(() => resolvePermissions(undefined, { profile: 'missing' }, {})).toThrow(
      /unknown permission profile/,
    )
  })
})

describe('TrustEnforcer — default-deny enforcement', () => {
  it('canCallTool denies anything not in allowlist', () => {
    const e = new TrustEnforcer(resolvePermissions({ allowedTools: ['gh.list_issues'] }, undefined))
    expect(e.canCallTool('gh.list_issues').allow).toBe(true)
    expect(e.canCallTool('gh.delete_repo').allow).toBe(false)
  })

  it('canCallTool honors prefix patterns (gh.*)', () => {
    const e = new TrustEnforcer(resolvePermissions({ allowedTools: ['gh.*'] }, undefined))
    expect(e.canCallTool('gh.list_issues').allow).toBe(true)
    expect(e.canCallTool('gh.create_pr').allow).toBe(true)
    expect(e.canCallTool('fs.read_file').allow).toBe(false)
  })

  it('canCallTool: deniedTools wins over allowedTools', () => {
    const e = new TrustEnforcer(
      resolvePermissions(
        {
          allowedTools: ['gh.*'],
          deniedTools: ['gh.delete_repo'],
        },
        undefined,
      ),
    )
    expect(e.canCallTool('gh.list_issues').allow).toBe(true)
    const denied = e.canCallTool('gh.delete_repo')
    expect(denied.allow).toBe(false)
    if (!denied.allow) expect(denied.reason).toBe('in-denylist')
  })

  it('canExec denies binaries not in allowedExecutables', () => {
    const e = new TrustEnforcer(resolvePermissions({ allowedExecutables: ['rg'] }, undefined))
    expect(e.canExec('rg').allow).toBe(true)
    const denied = e.canExec('rm')
    expect(denied.allow).toBe(false)
    if (!denied.allow) expect(denied.dimension).toBe('executable')
  })

  it('canFetch: deny means deny everything', () => {
    const e = new TrustEnforcer(resolvePermissions({ networkEgress: 'deny' }, undefined))
    expect(e.canFetch('api.github.com').allow).toBe(false)
  })

  it('canFetch: allowHosts permits exact host match', () => {
    const e = new TrustEnforcer(
      resolvePermissions({ networkEgress: { allowHosts: ['api.github.com'] } }, undefined),
    )
    expect(e.canFetch('api.github.com').allow).toBe(true)
    expect(e.canFetch('evil.example.com').allow).toBe(false)
  })

  it('canFetch: allow grants everything', () => {
    const e = new TrustEnforcer(resolvePermissions({ networkEgress: 'allow' }, undefined))
    expect(e.canFetch('anything.com').allow).toBe(true)
  })

  it('canRead/canWrite require path inside allow-listed root', () => {
    const e = new TrustEnforcer(
      resolvePermissions({ fsRead: ['/data'], fsWrite: ['/out'] }, undefined),
    )
    expect(e.canRead('/data/x.txt').allow).toBe(true)
    expect(e.canRead('/etc/passwd').allow).toBe(false)
    expect(e.canWrite('/out/result.json').allow).toBe(true)
    expect(e.canWrite('/data/x.txt').allow).toBe(false)
  })

  it('canAttachMcpServer / canLoadSkill default-deny', () => {
    const e = new TrustEnforcer(
      resolvePermissions({ allowedMcpServers: ['gh'], allowedSkills: ['triage'] }, undefined),
    )
    expect(e.canAttachMcpServer('gh').allow).toBe(true)
    expect(e.canAttachMcpServer('chat').allow).toBe(false)
    expect(e.canLoadSkill('triage').allow).toBe(true)
    expect(e.canLoadSkill('rogue').allow).toBe(false)
  })
})

describe('runPipeline — permission profiles', () => {
  it('applies project defaults and named profiles to agent steps', async () => {
    const registry = new BackendRegistry()
    let seenExecutables: ReadonlySet<string> | undefined
    const backend: SkelmBackend = {
      id: 'profile-backend',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run(req) {
        seenExecutables = req.permissions?.allowedExecutables
        return { text: 'ok' }
      },
    }
    registry.register(backend)

    const wf = pipeline({
      id: 'permission-profile-runner',
      steps: [
        agent({
          id: 'work',
          backend: 'profile-backend',
          prompt: 'hi',
          permissions: {
            profile: 'readonly',
            allowedExecutables: ['rg', 'curl'],
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, {
      backends: registry,
      defaultPermissions: { allowedExecutables: ['rg', 'git'] },
      permissionProfiles: {
        readonly: { allowedExecutables: ['rg', 'git', 'bash'] },
      },
    })

    expect(run.status).toBe('completed')
    expect(seenExecutables).toEqual(new Set(['rg']))
  })
})
