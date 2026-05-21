import { describe, expect, it } from 'vitest'
import { TrustEnforcer, resolvePermissions } from '../../src/permissions.js'

// Adversarial coverage at the TrustEnforcer level: every AgentPermissions
// dimension must default-deny when its allowlist is omitted, and explicitly
// deny when the requested value is outside the declared allowlist.
//
// Runtime enforcement status (as of v1 cut):
//   - tool        → enforced by mcp/host.ts (e2e fixture: permissions-adversarial)
//   - executable  → enforced by mcp/host.ts (e2e fixture: permissions-adversarial)
//   - mcp         → enforced by runner.ts   (e2e fixture: mcp-attach-adversarial)
//   - skill       → enforced by runner.ts makeSkillLoader via BackendContext.loadSkill
//                   (unit fixture: skill-loader.test.ts)
//   - network     → enforced by runner.ts via createPolicyFetch in BackendContext.fetch
//                   (unit fixture: policy-fetch.test.ts)
//   - fs.read     → enforced by mcp/host.ts requestedFsPath extractor (invokeTool)
//                   (unit fixture: mcp-fs-enforcement.test.ts)
//   - fs.write    → as above
//
// Helpers for the deferred dimensions are pinned here so a regression in
// the policy resolution layer surfaces immediately. Runtime call sites land
// alongside their owning subsystems (skill loader, fetch wrapper, fs proxy).

describe('dimension defaults — TrustEnforcer per-dimension default-deny', () => {
  it('tool: omitted allowedTools → all calls denied', () => {
    const e = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const decision = e.canCallTool('gh.list_issues')
    expect(decision.allow).toBe(false)
    if (!decision.allow) {
      expect(decision.dimension).toBe('tool')
      expect(decision.reason).toBe('not-in-allowlist')
    }
  })

  it('executable: omitted allowedExecutables → all execs denied', () => {
    const e = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const decision = e.canExec('rg')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.dimension).toBe('executable')
  })

  it('mcp: omitted allowedMcpServers → all attaches denied', () => {
    const e = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const decision = e.canAttachMcpServer('shell')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.dimension).toBe('mcp')
  })

  it('skill: omitted allowedSkills → all loads denied', () => {
    const e = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const decision = e.canLoadSkill('triage')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.dimension).toBe('skill')
  })

  it('secret: omitted allowedSecrets → all reads denied', () => {
    const e = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const decision = e.canAccessSecret('JIRA_API_TOKEN')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.dimension).toBe('secret')
  })

  it('network: omitted networkEgress → resolves to deny → all fetches denied', () => {
    const policy = resolvePermissions(undefined, undefined)
    expect(policy.networkEgress).toBe('deny')
    const decision = new TrustEnforcer(policy).canFetch('api.github.com')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.dimension).toBe('network')
  })

  it('fs.read: omitted fsRead → all reads denied', () => {
    const e = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const decision = e.canRead('/etc/passwd')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.dimension).toBe('fs.read')
  })

  it('fs.write: omitted fsWrite → all writes denied', () => {
    const e = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const decision = e.canWrite('/etc/passwd')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.dimension).toBe('fs.write')
  })

  it('approval: policy declares approval but no gate configured → fail closed', () => {
    // Pinned at the resolved-policy level: approval is carried through
    // resolvePermissions for the runtime to honour. The runtime-side
    // adversarial test (runs/agent-approval-no-gate.test) covers the
    // ApprovalDeniedError throw when no gate is wired.
    const policy = resolvePermissions({ approval: { on: ['tool'] } }, undefined)
    expect(policy.approval).not.toBeNull()
    expect(policy.approval?.on).toContain('tool')
  })
})

describe('dimension defaults — explicit-mismatch denials', () => {
  it('tool: deniedTools wins over allowedTools', () => {
    const e = new TrustEnforcer(
      resolvePermissions({ allowedTools: ['gh.*'], deniedTools: ['gh.delete_repo'] }, undefined),
    )
    const decision = e.canCallTool('gh.delete_repo')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toBe('in-denylist')
  })

  it('executable: not-in-allowlist denies even with allowlist set', () => {
    const e = new TrustEnforcer(resolvePermissions({ allowedExecutables: ['rg'] }, undefined))
    const decision = e.canExec('bash')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toBe('not-in-allowlist')
  })

  it('mcp: not-in-allowlist denies even with allowlist set', () => {
    const e = new TrustEnforcer(resolvePermissions({ allowedMcpServers: ['shell'] }, undefined))
    expect(e.canAttachMcpServer('shell').allow).toBe(true)
    expect(e.canAttachMcpServer('rogue').allow).toBe(false)
  })

  it('skill: not-in-allowlist denies even with allowlist set', () => {
    const e = new TrustEnforcer(resolvePermissions({ allowedSkills: ['triage'] }, undefined))
    expect(e.canLoadSkill('triage').allow).toBe(true)
    expect(e.canLoadSkill('exfil').allow).toBe(false)
  })

  it('secret: not-in-allowlist denies even with allowlist set', () => {
    const e = new TrustEnforcer(
      resolvePermissions({ allowedSecrets: ['JIRA_API_TOKEN'] }, undefined),
    )
    expect(e.canAccessSecret('JIRA_API_TOKEN').allow).toBe(true)
    const decision = e.canAccessSecret('GH_TOKEN')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toBe('not-in-allowlist')
  })

  it('network: allowHosts excludes everything else', () => {
    const e = new TrustEnforcer(
      resolvePermissions({ networkEgress: { allowHosts: ['api.github.com'] } }, undefined),
    )
    expect(e.canFetch('api.github.com').allow).toBe(true)
    const decision = e.canFetch('evil.example.com')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toBe('host-not-allowed')
  })

  it('fs.read: outside-root denies even with root set', () => {
    const e = new TrustEnforcer(resolvePermissions({ fsRead: ['/data'] }, undefined))
    expect(e.canRead('/data/x.txt').allow).toBe(true)
    expect(e.canRead('/etc/passwd').allow).toBe(false)
  })

  it('fs.write: outside-root denies even with root set', () => {
    const e = new TrustEnforcer(resolvePermissions({ fsWrite: ['/out'] }, undefined))
    expect(e.canWrite('/out/result.json').allow).toBe(true)
    expect(e.canWrite('/data/x.txt').allow).toBe(false)
  })
})
