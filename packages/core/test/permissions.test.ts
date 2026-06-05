import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../src/backend.js'
import { agent, pipeline } from '../src/builders.js'
import {
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  AutoApproveGate,
} from '../src/enforcement/index.js'
import { TrustEnforcer, intersectResolvedPolicies, resolvePermissions } from '../src/permissions.js'
import { runPipeline } from '../src/runner.js'

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

  it('intersects executable bare-name ceilings with exact absolute-path step grants', () => {
    const policy = resolvePermissions(
      { allowedExecutables: ['git'] },
      { allowedExecutables: ['/tmp/skelm/git'] },
    )
    expect([...policy.allowedExecutables]).toEqual(['/tmp/skelm/git'])
    expect(new TrustEnforcer(policy).canExec('/tmp/skelm/git')).toEqual({ allow: true })
    expect(new TrustEnforcer(policy).canExec('/tmp/other/git').allow).toBe(false)
  })

  it('intersects executable exact-path ceilings with bare-name step grants', () => {
    const policy = resolvePermissions(
      { allowedExecutables: ['/usr/bin/git'] },
      { allowedExecutables: ['git'] },
    )
    expect([...policy.allowedExecutables]).toEqual(['/usr/bin/git'])
    expect(new TrustEnforcer(policy).canExec('/usr/bin/git')).toEqual({ allow: true })
    expect(new TrustEnforcer(policy).canExec('git').allow).toBe(false)
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

  it('canAccessSecret default-deny', () => {
    const allowed = new TrustEnforcer(
      resolvePermissions({ allowedSecrets: ['JIRA_API_TOKEN'] }, undefined),
    )
    expect(allowed.canAccessSecret('JIRA_API_TOKEN').allow).toBe(true)
    const decision = allowed.canAccessSecret('GH_TOKEN')
    expect(decision.allow).toBe(false)
    if (!decision.allow) {
      expect(decision.dimension).toBe('secret')
    }
    const empty = new TrustEnforcer(resolvePermissions(undefined, undefined))
    expect(empty.canAccessSecret('any').allow).toBe(false)
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

describe('runPipeline — approval gate', () => {
  function fakeBackend(): SkelmBackend {
    return {
      id: 'gated-backend',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run() {
        return { text: 'ok' }
      },
    }
  }

  function pipelineWithApproval() {
    return pipeline({
      id: 'gated',
      steps: [
        agent({
          id: 'work',
          backend: 'gated-backend',
          prompt: 'hi',
          permissions: {
            allowedExecutables: ['echo'],
            approval: { on: ['executable'] },
          },
        }),
      ],
    })
  }

  it('invokes the approval gate at agent step start when policy.approval is set', async () => {
    const registry = new BackendRegistry()
    registry.register(fakeBackend())
    const requests: ApprovalRequest[] = []
    const gate: ApprovalGate = {
      async request(req) {
        requests.push(req)
        return { approved: true, approver: 'auto' }
      },
    }
    const run = await runPipeline(pipelineWithApproval(), undefined, {
      backends: registry,
      approvalGate: gate,
    })
    expect(run.status).toBe('completed')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.action).toBe('agent.start')
    expect(requests[0]?.context).toMatchObject({ dimensions: ['executable'] })
  })

  it('fails the step when the gate denies', async () => {
    const registry = new BackendRegistry()
    registry.register(fakeBackend())
    const gate: ApprovalGate = {
      async request(): Promise<ApprovalDecision> {
        return { approved: false, approver: 'auto', reason: 'blocked' }
      },
    }
    const run = await runPipeline(pipelineWithApproval(), undefined, {
      backends: registry,
      approvalGate: gate,
    })
    expect(run.status).toBe('failed')
    expect(run.steps[0]?.error?.message).toMatch(/approval denied/)
  })

  it('does not invoke the gate when policy.approval is omitted', async () => {
    const registry = new BackendRegistry()
    registry.register(fakeBackend())
    let count = 0
    const gate: ApprovalGate = {
      async request() {
        count++
        return { approved: true }
      },
    }
    const wf = pipeline({
      id: 'no-approval',
      steps: [
        agent({
          id: 'work',
          backend: 'gated-backend',
          prompt: 'hi',
          permissions: { allowedExecutables: ['echo'] },
        }),
      ],
    })
    await runPipeline(wf, undefined, { backends: registry, approvalGate: gate })
    expect(count).toBe(0)
  })

  it('AutoApproveGate (the default) approves transparently', async () => {
    const registry = new BackendRegistry()
    registry.register(fakeBackend())
    const run = await runPipeline(pipelineWithApproval(), undefined, {
      backends: registry,
      approvalGate: new AutoApproveGate(),
    })
    expect(run.status).toBe('completed')
  })
})

describe('delegation dimension — canDelegate', () => {
  it('denies every target when delegation is omitted (default-deny)', () => {
    const enforcer = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const decision = enforcer.canDelegate('any.agent')
    expect(decision.allow).toBe(false)
    if (!decision.allow) {
      expect(decision.dimension).toBe('delegation')
      expect(decision.reason).toBe('not-in-allowlist')
    }
  })

  it('allows only allowlisted ids, by exact id, prefix, and star', () => {
    const exact = new TrustEnforcer(
      resolvePermissions(undefined, { delegation: ['research.agent'] }),
    )
    expect(exact.canDelegate('research.agent').allow).toBe(true)
    expect(exact.canDelegate('other.agent').allow).toBe(false)

    const prefix = new TrustEnforcer(resolvePermissions(undefined, { delegation: ['team.*'] }))
    expect(prefix.canDelegate('team.writer').allow).toBe(true)
    expect(prefix.canDelegate('rogue.writer').allow).toBe(false)

    const star = new TrustEnforcer(resolvePermissions(undefined, { delegation: ['*'] }))
    expect(star.canDelegate('whatever.agent').allow).toBe(true)
  })

  it('intersects delegation allowlists; a step cannot widen the project default', () => {
    const policy = resolvePermissions(
      { delegation: ['a.agent', 'b.agent'] },
      { delegation: ['b.agent', 'c.agent'] },
    )
    const enforcer = new TrustEnforcer(policy)
    expect(enforcer.canDelegate('b.agent').allow).toBe(true)
    expect(enforcer.canDelegate('a.agent').allow).toBe(false)
    expect(enforcer.canDelegate('c.agent').allow).toBe(false)
  })

  it('unrestricted bypass allows any delegation target', () => {
    const policy = resolvePermissions(
      undefined,
      { requestUnrestricted: true },
      {},
      {
        grantUnrestricted: true,
      },
    )
    expect(new TrustEnforcer(policy).canDelegate('anything').allow).toBe(true)
  })
})

describe('intersectResolvedPolicies — child bounded by parent ceiling', () => {
  it('caps a child that declares more than the parent grants', () => {
    const ceiling = resolvePermissions(undefined, {
      allowedTools: ['a.*'],
      allowedExecutables: ['rg'],
      fsRead: ['/data'],
      networkEgress: { allowHosts: ['api.example.com'] },
    })
    const child = resolvePermissions(undefined, {
      allowedTools: ['*'],
      allowedExecutables: ['rg', 'bash'],
      fsRead: ['/data', '/etc'],
      networkEgress: 'allow',
    })
    const bounded = new TrustEnforcer(intersectResolvedPolicies(ceiling, child))
    expect(bounded.canCallTool('a.read').allow).toBe(true)
    expect(bounded.canCallTool('b.read').allow).toBe(false)
    expect(bounded.canExec('rg').allow).toBe(true)
    expect(bounded.canExec('bash').allow).toBe(false)
    expect(bounded.canRead('/data/x').allow).toBe(true)
    expect(bounded.canRead('/etc/passwd').allow).toBe(false)
    expect(bounded.canFetch('api.example.com').allow).toBe(true)
    expect(bounded.canFetch('evil.com').allow).toBe(false)
  })

  it('unions denylists down the chain', () => {
    const ceiling = resolvePermissions(undefined, {
      allowedTools: ['*'],
      deniedTools: ['x.danger'],
    })
    const child = resolvePermissions(undefined, { allowedTools: ['*'], deniedTools: ['y.danger'] })
    const bounded = new TrustEnforcer(intersectResolvedPolicies(ceiling, child))
    expect(bounded.canCallTool('x.danger').allow).toBe(false)
    expect(bounded.canCallTool('y.danger').allow).toBe(false)
    expect(bounded.canCallTool('z.safe').allow).toBe(true)
  })

  it('caps the child delegation allowlist so re-delegation cannot widen', () => {
    const ceiling = resolvePermissions(undefined, { delegation: ['team.*'] })
    const child = resolvePermissions(undefined, { delegation: ['*'] })
    const bounded = new TrustEnforcer(intersectResolvedPolicies(ceiling, child))
    expect(bounded.canDelegate('team.writer').allow).toBe(true)
    expect(bounded.canDelegate('outsider.agent').allow).toBe(false)
  })

  it('a restricted parent caps a child that independently earned unrestricted', () => {
    const ceiling = resolvePermissions(undefined, { allowedTools: ['a.*'] })
    const childUnrestricted = resolvePermissions(
      undefined,
      { requestUnrestricted: true },
      {},
      {
        grantUnrestricted: true,
      },
    )
    const bounded = intersectResolvedPolicies(ceiling, childUnrestricted)
    expect(bounded.unrestricted).toBe(false)
    expect(new TrustEnforcer(bounded).canCallTool('b.read').allow).toBe(false)
  })

  it('an unrestricted parent empowers the child (parent-empowers-child)', () => {
    const ceilingUnrestricted = resolvePermissions(
      undefined,
      { requestUnrestricted: true },
      {},
      {
        grantUnrestricted: true,
      },
    )
    const child = resolvePermissions(undefined, { allowedTools: ['a.*'] })
    const bounded = intersectResolvedPolicies(ceilingUnrestricted, child)
    expect(bounded.unrestricted).toBe(true)
    expect(new TrustEnforcer(bounded).canExec('anything').allow).toBe(true)
  })

  it('unions approval gating so it only tightens down the chain', () => {
    const ceiling = resolvePermissions(undefined, {
      allowedTools: ['*'],
      approval: { on: ['fs.write'], rememberFor: 1000 },
    })
    const child = resolvePermissions(undefined, {
      allowedTools: ['*'],
      approval: { on: ['network'], rememberFor: 500 },
    })
    const bounded = intersectResolvedPolicies(ceiling, child)
    expect(bounded.approval?.on).toEqual(expect.arrayContaining(['fs.write', 'network']))
    expect(bounded.approval?.rememberFor).toBe(500)
  })
})
