// Self-test for @skelm/security-auditor. Builds in-memory fixture workflows and
// asserts each rule fires with the expected severity — and that no secret value
// ever appears in the report. Runs without a network, model, or filesystem
// dependency: pure inspection of authored permissions and source text.

import { agent, check, code, pipeline } from '@skelm/core'
import type { Pipeline } from '@skelm/core'
import { summarizeChecks } from '@skelm/core/testing'
import { auditWorkflow } from '../src/audit.js'
import type { Finding, RuleId } from '../src/types.js'

function privilegedAgent(
  id: string,
  permissions: Parameters<typeof agent>[0]['permissions'],
): Pipeline {
  return pipeline({
    id: `fixture-${id}`,
    steps: [agent({ id, prompt: 'noop', ...(permissions !== undefined && { permissions }) })],
  })
}

function hasRule(findings: readonly Finding[], rule: RuleId): boolean {
  return findings.some((f) => f.rule === rule)
}

const CHECK_IDS = [
  'clean',
  'broad-fs-write',
  'wildcard-egress',
  'unrestricted',
  'secret-value',
  'risky-executable',
  'missing-approval',
  'no-secret-leak',
] as const

export default pipeline({
  id: 'security-auditor-selftest',
  description: 'Self-test for the skelm security auditor.',
  steps: [
    check({
      id: 'clean',
      run: () => {
        const wf = pipeline({
          id: 'clean',
          steps: [code({ id: 'pure', run: () => ({ ok: true }) })],
        })
        const report = auditWorkflow({ workflow: wf })
        if (report.findings.length !== 0) throw new Error('clean workflow produced findings')
        if (!report.ok) throw new Error('clean workflow not ok')
        return report
      },
    }),
    check({
      id: 'broad-fs-write',
      run: () => {
        const wf = privilegedAgent('writer', { fsWrite: ['/'] })
        const report = auditWorkflow({ workflow: wf })
        const f = report.findings.find((x) => x.rule === 'fs-write-broad')
        if (f === undefined || f.severity !== 'high') throw new Error('fs-write-broad not high')
        return f
      },
    }),
    check({
      id: 'wildcard-egress',
      run: () => {
        const wf = privilegedAgent('net', { networkEgress: { allowHosts: ['*.evil.com'] } })
        const report = auditWorkflow({ workflow: wf })
        const f = report.findings.find((x) => x.rule === 'network-egress-broad')
        if (f === undefined || f.severity !== 'medium')
          throw new Error('wildcard egress not medium')
        return f
      },
    }),
    check({
      id: 'unrestricted',
      run: () => {
        const wf = privilegedAgent('free', { requestUnrestricted: true })
        const report = auditWorkflow({ workflow: wf })
        const f = report.findings.find((x) => x.rule === 'unrestricted-grant')
        if (f === undefined || f.severity !== 'high') throw new Error('unrestricted not high')
        return f
      },
    }),
    check({
      id: 'secret-value',
      run: () => {
        const wf = pipeline({ id: 'leaky', steps: [code({ id: 'c', run: () => 1 })] })
        const source = 'const k = "AKIAIOSFODNN7EXAMPLE"'
        const report = auditWorkflow({ workflow: wf, source, file: 'leaky.ts' })
        const f = report.findings.find((x) => x.rule === 'secret-value-in-source')
        if (f === undefined || f.severity !== 'high') throw new Error('secret-value not high')
        return f
      },
    }),
    check({
      id: 'risky-executable',
      run: () => {
        const wf = privilegedAgent('shell', { allowedExecutables: ['/bin/bash'] })
        const report = auditWorkflow({ workflow: wf })
        const f = report.findings.find((x) => x.rule === 'risky-executable-profile')
        if (f === undefined || f.severity !== 'high') throw new Error('risky-executable not high')
        return f
      },
    }),
    check({
      id: 'missing-approval',
      run: () => {
        const wf = privilegedAgent('priv', { allowedExecutables: ['git'] })
        const report = auditWorkflow({ workflow: wf })
        const f = report.findings.find((x) => x.rule === 'missing-approval-privileged')
        if (f === undefined || f.severity !== 'medium')
          throw new Error('missing-approval not medium')
        return f
      },
    }),
    check({
      id: 'no-secret-leak',
      run: () => {
        const wf = pipeline({ id: 'leaky2', steps: [code({ id: 'c', run: () => 1 })] })
        const value = 'AKIAIOSFODNN7EXAMPLE'
        const report = auditWorkflow({ workflow: wf, source: `const k = "${value}"` })
        const blob = JSON.stringify(report)
        if (blob.includes(value)) throw new Error('raw secret value leaked into report')
        return { redactedOnly: true }
      },
    }),
  ],
  finalize: (ctx) => summarizeChecks('security-auditor', [...CHECK_IDS], ctx, Date.now()),
})
