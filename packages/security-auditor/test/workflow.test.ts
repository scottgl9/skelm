import { agent, pipeline, runPipeline } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import type { AuditReport } from '../src/types.js'
import selfTest from '../workflows/audit.selftest.js'
import auditPipeline from '../workflows/audit.workflow.js'
import type { AuditPipelineInput } from '../workflows/audit.workflow.js'

describe('audit entrypoint pipeline', () => {
  it('audits a target workflow and returns a report without executing it', async () => {
    const target = pipeline({
      id: 'target',
      steps: [agent({ id: 'a', prompt: 'noop', permissions: { fsWrite: ['/'] } })],
    })
    const run = await runPipeline<AuditPipelineInput, AuditReport>(auditPipeline, {
      workflow: target,
    })
    expect(run.status).toBe('completed')
    expect(run.output?.findings.some((f) => f.rule === 'fs-write-broad')).toBe(true)
    expect(run.output?.ok).toBe(false)
  })

  it('never echoes a planted secret value into its output', async () => {
    const value = 'AKIAIOSFODNN7EXAMPLE'
    const target = pipeline({ id: 't2', steps: [agent({ id: 'a', prompt: 'noop' })] })
    const run = await runPipeline<AuditPipelineInput, AuditReport>(auditPipeline, {
      workflow: target,
      source: `const k = "${value}"`,
      file: 't2.ts',
    })
    expect(run.status).toBe('completed')
    expect(JSON.stringify(run.output)).not.toContain(value)
    expect(run.output?.findings.some((f) => f.rule === 'secret-value-in-source')).toBe(true)
  })
})

describe('self-test pipeline', () => {
  it('all checks pass', async () => {
    const run = await runPipeline(selfTest, {})
    expect(run.status).toBe('completed')
    const section = run.output as { failCount: number; passCount: number; status: string }
    expect(section.failCount).toBe(0)
    expect(section.passCount).toBe(8)
    expect(section.status).toBe('pass')
  })
})
