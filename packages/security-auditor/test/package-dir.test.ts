import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePackageManifest } from '@skelm/core'
import type { Pipeline } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { auditPackage } from '../src/audit.js'
import type { PackageWorkflowInput } from '../src/audit.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-package')

describe('auditPackage over a fixture package directory', () => {
  it('parses the manifest, loads entries, and reports findings with drift', async () => {
    const manifest = parsePackageManifest(
      await readFile(join(FIXTURE, 'skelm.package.json'), 'utf8'),
      'skelm.package.json',
    )

    const inputs: PackageWorkflowInput[] = []
    for (const entry of manifest.skelm.workflows) {
      const mod = (await import(join(FIXTURE, entry.entry))) as { default: Pipeline }
      const file = join(FIXTURE, entry.entry)
      inputs.push({
        workflow: mod.default,
        source: await readFile(file, 'utf8'),
        file,
        ...(entry.permissions !== undefined && { manifestPermissions: entry.permissions }),
      })
    }

    const report = auditPackage(manifest, inputs)
    const rules = new Set(report.findings.map((f) => f.rule))
    expect(rules.has('fs-write-broad')).toBe(true)
    expect(rules.has('risky-executable-profile')).toBe(true)
    // `UNUSED_SECRET` is in the manifest ceiling but never used by the workflow.
    expect(rules.has('manifest-permission-drift')).toBe(true)
    expect(report.ok).toBe(false)
    // The clean entry contributes no findings of its own.
    const cleanScoped = report.findings.filter((f) => f.location.workflowId === 'clean')
    expect(cleanScoped).toHaveLength(0)
  })
})
