import { agent, code, parallel, pipeline } from '@skelm/core'
import type { AgentPermissions, PipelineTrigger, WorkflowPackageManifest } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { auditPackage, auditWorkflow } from '../src/audit.js'
import type { RuleId, Severity } from '../src/types.js'

function agentWorkflow(
  id: string,
  permissions: AgentPermissions,
  triggers?: readonly PipelineTrigger[],
) {
  return pipeline({
    id,
    steps: [agent({ id: 'step', prompt: 'noop', permissions })],
    ...(triggers !== undefined && { triggers }),
  })
}

function rule(findings: readonly { rule: RuleId; severity: Severity }[], id: RuleId) {
  return findings.find((f) => f.rule === id)
}

describe('auditWorkflow — clean', () => {
  it('produces no findings and is ok', () => {
    const wf = pipeline({ id: 'clean', steps: [code({ id: 'pure', run: () => ({}) })] })
    const report = auditWorkflow({ workflow: wf })
    expect(report.findings).toHaveLength(0)
    expect(report.ok).toBe(true)
    expect(report.summary).toEqual({ high: 0, medium: 0, low: 0 })
  })
})

describe('auditWorkflow — fs-write-broad (high)', () => {
  it('flags a broad fsWrite root with location', () => {
    const wf = agentWorkflow('fs', { fsWrite: ['/'] })
    const report = auditWorkflow({ workflow: wf })
    const f = rule(report.findings, 'fs-write-broad')
    expect(f?.severity).toBe('high')
    expect(report.findings[0]?.location).toMatchObject({ workflowId: 'fs', stepId: 'step' })
    expect(report.ok).toBe(false)
  })
})

describe('auditWorkflow — network-egress-broad', () => {
  it('flags allow as high', () => {
    const wf = agentWorkflow('net', { networkEgress: 'allow' })
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'network-egress-broad')
    expect(f?.severity).toBe('high')
  })

  it('flags a wildcard host as medium', () => {
    const wf = agentWorkflow('net', { networkEgress: { allowHosts: ['*.evil.com'] } })
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'network-egress-broad')
    expect(f?.severity).toBe('medium')
  })

  it('does not flag a concrete allowHosts entry', () => {
    const wf = agentWorkflow('net', { networkEgress: { allowHosts: ['api.github.com'] } })
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'network-egress-broad')
    expect(f).toBeUndefined()
  })
})

describe('auditWorkflow — unrestricted-grant (high)', () => {
  it('flags requestUnrestricted', () => {
    const wf = agentWorkflow('free', { requestUnrestricted: true })
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'unrestricted-grant')
    expect(f?.severity).toBe('high')
  })
})

describe('auditWorkflow — secret-value-in-source (high, redacted)', () => {
  it('flags a planted secret value and never leaks it', () => {
    const value = 'AKIAIOSFODNN7EXAMPLE'
    const wf = pipeline({ id: 'leaky', steps: [code({ id: 'c', run: () => 1 })] })
    const report = auditWorkflow({ workflow: wf, source: `const k = "${value}"`, file: 'leaky.ts' })
    const f = rule(report.findings, 'secret-value-in-source')
    expect(f?.severity).toBe('high')
    expect(JSON.stringify(report)).not.toContain(value)
    const found = report.findings.find((x) => x.rule === 'secret-value-in-source')
    expect(found?.location).toMatchObject({ file: 'leaky.ts', line: 1 })
    expect(found?.detail).toContain('AKIA')
  })
})

describe('auditWorkflow — risky-executable-profile (high)', () => {
  it('flags a shell executable', () => {
    const wf = agentWorkflow('shell', { allowedExecutables: ['/bin/bash'] })
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'risky-executable-profile')
    expect(f?.severity).toBe('high')
  })

  it('flags a risky executable profile name', () => {
    const wf = agentWorkflow('shell', { executableProfiles: ['docker'] })
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'risky-executable-profile')
    expect(f?.severity).toBe('high')
  })
})

describe('auditWorkflow — missing-approval-privileged (medium)', () => {
  it('flags a privileged dimension with no approval gate', () => {
    const wf = agentWorkflow('priv', { allowedExecutables: ['git'] })
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'missing-approval-privileged')
    expect(f?.severity).toBe('medium')
  })

  it('does not flag when an approval gates the dimension', () => {
    const wf = agentWorkflow('priv', {
      allowedExecutables: ['git'],
      approval: { on: ['executable'] },
    })
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'missing-approval-privileged')
    expect(f).toBeUndefined()
  })
})

describe('auditWorkflow — unverified-webhook-trigger (medium)', () => {
  it('flags an unverified webhook trigger', () => {
    const wf = agentWorkflow('hook', { allowedSecrets: ['X'], approval: { on: ['secret'] } }, [
      { kind: 'webhook', path: '/hook' },
    ])
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'unverified-webhook-trigger')
    expect(f?.severity).toBe('medium')
  })

  it('does not flag a webhook with a signing secret', () => {
    const wf = agentWorkflow('hook', { allowedSecrets: ['X'], approval: { on: ['secret'] } }, [
      { kind: 'webhook', path: '/hook', secret: 'WEBHOOK_SECRET' },
    ])
    const f = rule(auditWorkflow({ workflow: wf }).findings, 'unverified-webhook-trigger')
    expect(f).toBeUndefined()
  })
})

describe('auditWorkflow — manifest-permission-drift (medium)', () => {
  it('flags a declared dimension the workflow never uses', () => {
    const wf = pipeline({ id: 'drift', steps: [code({ id: 'pure', run: () => 1 })] })
    const report = auditWorkflow({
      workflow: wf,
      manifestPermissions: { fsWrite: ['/var/run/app'] },
    })
    const f = rule(report.findings, 'manifest-permission-drift')
    expect(f?.severity).toBe('medium')
  })

  it('flags a used dimension the manifest never declares', () => {
    const wf = agentWorkflow('drift', { allowedExecutables: ['git'] })
    const report = auditWorkflow({
      workflow: wf,
      manifestPermissions: { approval: { on: ['executable'] } },
    })
    const f = rule(report.findings, 'manifest-permission-drift')
    expect(f?.severity).toBe('medium')
    expect(f?.title).toContain('manifest never declares')
  })
})

describe('config — toggles and thresholds', () => {
  it('skips a disabled rule', () => {
    const wf = agentWorkflow('fs', { fsWrite: ['/'] })
    const report = auditWorkflow(
      { workflow: wf },
      { rules: { 'fs-write-broad': { enabled: false } } },
    )
    expect(rule(report.findings, 'fs-write-broad')).toBeUndefined()
  })

  it('honours a severity override', () => {
    const wf = agentWorkflow('fs', { fsWrite: ['/'] })
    const report = auditWorkflow(
      { workflow: wf },
      { rules: { 'fs-write-broad': { severity: 'low' } } },
    )
    expect(rule(report.findings, 'fs-write-broad')?.severity).toBe('low')
  })

  it('failOn threshold controls ok', () => {
    const wf = agentWorkflow('priv', { allowedExecutables: ['git'] })
    expect(auditWorkflow({ workflow: wf }).ok).toBe(true)
    expect(auditWorkflow({ workflow: wf }, { failOn: 'medium' }).ok).toBe(false)
  })
})

describe('auditPackage', () => {
  it('merges findings across entries and reads manifest ceilings by id', () => {
    const manifest: WorkflowPackageManifest = {
      name: '@skelm/fixture',
      version: '0.0.1',
      skelm: {
        apiVersion: 1,
        workflows: [{ id: 'drift', entry: 'a.ts', permissions: { fsWrite: ['/var/x'] } }],
      },
    }
    const wf = pipeline({ id: 'drift', steps: [code({ id: 'pure', run: () => 1 })] })
    const report = auditPackage(manifest, [{ workflow: wf }])
    expect(rule(report.findings, 'manifest-permission-drift')?.severity).toBe('medium')
  })

  it('flags when a workflow outgrows its manifest ceiling', () => {
    const manifest: WorkflowPackageManifest = {
      name: '@skelm/fixture',
      version: '0.0.1',
      skelm: {
        apiVersion: 1,
        workflows: [{ id: 'drift', entry: 'a.ts', permissions: {} }],
      },
    }
    const wf = agentWorkflow('drift', { allowedExecutables: ['git'] })
    const report = auditPackage(manifest, [{ workflow: wf }])
    const f = rule(report.findings, 'manifest-permission-drift')
    expect(f?.severity).toBe('medium')
    expect(f?.title).toContain('manifest never declares')
  })

  it('descends into nested control-flow steps', () => {
    const inner = agent({ id: 'inner', prompt: 'x', permissions: { fsWrite: ['/'] } })
    const wf = pipeline({
      id: 'nested',
      steps: [parallel({ id: 'par', steps: [inner] })],
    })
    const report = auditWorkflow({ workflow: wf })
    expect(rule(report.findings, 'fs-write-broad')).toBeDefined()
  })
})
