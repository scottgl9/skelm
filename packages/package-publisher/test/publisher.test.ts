import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePackageManifest } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { buildPermissionSummary, runPublish, scanPackageForSecrets } from '../src/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string) => join(FIXTURES, name)

describe('runPublish — valid package', () => {
  it('passes every stage, summarizes permissions, dry-runs without publishing', async () => {
    const report = await runPublish(fixture('valid'))
    expect(report.ok).toBe(true)
    expect(report.name).toBe('@fixtures/valid')
    expect(report.version).toBe('1.0.0')
    expect(report.stages).toEqual({
      validateManifest: 'passed',
      permissionSummary: 'passed',
      secretScan: 'passed',
      selfTest: 'passed',
      dryRun: 'passed',
    })
    expect(report.secretFindings).toEqual([])

    // Permission summary is accurate and references-only.
    const wf = report.permissions?.workflows[0]
    expect(wf?.id).toBe('default')
    expect(wf?.hasPermissions).toBe(true)
    expect(wf?.allowedExecutables).toEqual(['node'])
    expect(wf?.executableProfiles).toEqual(['build-tools'])
    expect(wf?.declaresNetworkEgress).toBe(true)
    expect(wf?.fsRead).toEqual(['./data'])
    expect(wf?.fsWrite).toEqual(['./out'])
    expect(wf?.allowedSecrets).toEqual(['GREETER_TOKEN'])
    expect(report.permissions?.declaredSecrets).toEqual(['GREETER_TOKEN'])
    expect(report.permissions?.integrations).toEqual(['github'])
    expect(report.permissions?.triggers).toEqual([{ id: 'daily', kind: 'cron' }])

    // Dry-run lists files + integrity and never publishes.
    expect(report.dryRun?.published).toBe(false)
    expect(report.dryRun?.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    const paths = report.dryRun?.files.map((f) => f.path) ?? []
    expect(paths).toContain('skelm.package.json')
    expect(paths).toContain('workflows/main.workflow.ts')
    expect(report.dryRun?.totalBytes ?? 0).toBeGreaterThan(0)
  })

  it('permission summary carries no secret VALUES', async () => {
    const report = await runPublish(fixture('valid'))
    const serialized = JSON.stringify(report.permissions)
    // Names are fine; assert nothing token-shaped leaked.
    expect(serialized).not.toMatch(/ghp_|AKIA|xox[baprs]-|sk_live_/)
  })
})

describe('runPublish — invalid manifest', () => {
  it('fails validation with a typed error and runs no later stage', async () => {
    const report = await runPublish(fixture('bad-manifest'))
    expect(report.ok).toBe(false)
    expect(report.stages.validateManifest).toBe('failed')
    expect(report.manifestError).toMatch(/apiVersion/)
    expect(report.stages.secretScan).toBe('skipped')
    expect(report.stages.dryRun).toBe('skipped')
    expect(report.permissions).toBeUndefined()
  })
})

describe('runPublish — planted secret', () => {
  // The planted token is assembled from fragments and written into a temp
  // package at runtime, so no committed file holds a contiguous token-shaped
  // literal (which would trip secret push-protection). The scanner reads the
  // file from disk, where it sees the joined value.
  const planted = `ghp_${'aB3dEf7Hj9kLmN2pQ4rS6tU8vWx1Yz0AbCdE'}`

  it('fails the secret scan and reports redacted matches only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-planted-'))
    try {
      await writeFile(
        join(dir, 'skelm.package.json'),
        JSON.stringify({
          name: '@fixtures/planted-secret',
          version: '1.0.0',
          description: 'Runtime fixture with a planted fake secret.',
          license: 'MIT',
          skelm: {
            apiVersion: 1,
            workflows: [{ id: 'default', entry: 'workflows/main.workflow.ts', kind: 'pipeline' }],
          },
        }),
      )
      await mkdir(join(dir, 'workflows'), { recursive: true })
      await writeFile(
        join(dir, 'workflows', 'main.workflow.ts'),
        `export const token = ${JSON.stringify(planted)}\n`,
      )

      const report = await runPublish(dir)
      expect(report.ok).toBe(false)
      expect(report.stages.secretScan).toBe('failed')
      expect(report.secretFindings.length).toBeGreaterThan(0)

      const serialized = JSON.stringify(report)
      expect(serialized).not.toContain(planted)
      expect(serialized).not.toContain(planted.slice(4))
      for (const f of report.secretFindings) {
        expect(f.file).toBe('workflows/main.workflow.ts')
        expect(f.redacted).not.toContain(planted)
        expect(f.fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runPublish — missing self-test', () => {
  it('skips the self-test stage but still passes overall', async () => {
    const report = await runPublish(fixture('no-selftest'))
    expect(report.ok).toBe(true)
    expect(report.stages.selfTest).toBe('skipped')
    expect(report.selfTest.status).toBe('skipped')
    expect(report.dryRun?.published).toBe(false)
  })

  it('honours runSelfTest:false on a package that declares one', async () => {
    const report = await runPublish(fixture('valid'), { runSelfTest: false })
    expect(report.ok).toBe(true)
    expect(report.stages.selfTest).toBe('skipped')
    expect(report.selfTest.entry).toBe('workflows/self-test.ts')
  })

  it('validates a declared self-test without executing package code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-selftest-noexec-'))
    try {
      await writeFile(
        join(dir, 'skelm.package.json'),
        JSON.stringify({
          name: '@fixtures/non-executing-self-test',
          version: '1.0.0',
          description: 'Runtime fixture proving self-test modules are not executed.',
          license: 'MIT',
          skelm: {
            apiVersion: 1,
            workflows: [{ id: 'default', entry: 'workflows/main.workflow.ts', kind: 'pipeline' }],
            selfTest: { entry: 'workflows/self-test.ts' },
          },
        }),
      )
      await mkdir(join(dir, 'workflows'), { recursive: true })
      await writeFile(join(dir, 'workflows', 'main.workflow.ts'), 'export default { steps: [] }\n')
      await writeFile(
        join(dir, 'workflows', 'self-test.ts'),
        [
          "throw new Error('self-test module should not execute during publish checks')",
          'export default function selfTest(): void {}',
          '',
        ].join('\n'),
      )

      const report = await runPublish(dir)
      expect(report.ok).toBe(true)
      expect(report.stages.selfTest).toBe('passed')
      expect(report.selfTest).toEqual({
        status: 'passed',
        entry: 'workflows/self-test.ts',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails when the declared self-test module has no default export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-selftest-default-export-'))
    try {
      await writeFile(
        join(dir, 'skelm.package.json'),
        JSON.stringify({
          name: '@fixtures/invalid-self-test',
          version: '1.0.0',
          description: 'Runtime fixture with an invalid self-test module.',
          license: 'MIT',
          skelm: {
            apiVersion: 1,
            workflows: [{ id: 'default', entry: 'workflows/main.workflow.ts', kind: 'pipeline' }],
            selfTest: { entry: 'workflows/self-test.ts' },
          },
        }),
      )
      await mkdir(join(dir, 'workflows'), { recursive: true })
      await writeFile(join(dir, 'workflows', 'main.workflow.ts'), 'export default { steps: [] }\n')
      await writeFile(join(dir, 'workflows', 'self-test.ts'), 'export const selfTest = () => {}\n')

      const report = await runPublish(dir)
      expect(report.ok).toBe(false)
      expect(report.stages.selfTest).toBe('failed')
      expect(report.selfTest).toEqual({
        status: 'failed',
        entry: 'workflows/self-test.ts',
        detail: 'self-test module must declare a default export',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts a self-test module that re-exports default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-selftest-reexport-default-'))
    try {
      await writeFile(
        join(dir, 'skelm.package.json'),
        JSON.stringify({
          name: '@fixtures/reexport-self-test',
          version: '1.0.0',
          description: 'Runtime fixture with a re-exported default self-test module.',
          license: 'MIT',
          skelm: {
            apiVersion: 1,
            workflows: [{ id: 'default', entry: 'workflows/main.workflow.ts', kind: 'pipeline' }],
            selfTest: { entry: 'workflows/self-test.ts' },
          },
        }),
      )
      await mkdir(join(dir, 'workflows'), { recursive: true })
      await writeFile(join(dir, 'workflows', 'main.workflow.ts'), 'export default { steps: [] }\n')
      await writeFile(
        join(dir, 'workflows', 'self-test.ts'),
        ['const selfTest = (): void => {}', 'export { selfTest as default }', ''].join('\n'),
      )

      const report = await runPublish(dir)
      expect(report.ok).toBe(true)
      expect(report.stages.selfTest).toBe('passed')
      expect(report.selfTest).toEqual({
        status: 'passed',
        entry: 'workflows/self-test.ts',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores comment and string false positives when checking default exports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-selftest-false-positive-'))
    try {
      await writeFile(
        join(dir, 'skelm.package.json'),
        JSON.stringify({
          name: '@fixtures/false-positive-self-test',
          version: '1.0.0',
          description: 'Runtime fixture with fake default-export text only.',
          license: 'MIT',
          skelm: {
            apiVersion: 1,
            workflows: [{ id: 'default', entry: 'workflows/main.workflow.ts', kind: 'pipeline' }],
            selfTest: { entry: 'workflows/self-test.ts' },
          },
        }),
      )
      await mkdir(join(dir, 'workflows'), { recursive: true })
      await writeFile(join(dir, 'workflows', 'main.workflow.ts'), 'export default { steps: [] }\n')
      await writeFile(
        join(dir, 'workflows', 'self-test.ts'),
        [
          'const note = "export default from a string"',
          '// export default from a comment',
          'export const selfTest = (): void => {}',
          '',
        ].join('\n'),
      )

      const report = await runPublish(dir)
      expect(report.ok).toBe(false)
      expect(report.stages.selfTest).toBe('failed')
      expect(report.selfTest).toEqual({
        status: 'failed',
        entry: 'workflows/self-test.ts',
        detail: 'self-test module must declare a default export',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('scanPackageForSecrets', () => {
  it('returns no findings for a clean package', async () => {
    expect(await scanPackageForSecrets(fixture('valid'))).toEqual([])
  })
})

describe('buildPermissionSummary', () => {
  it('reports defaults for a workflow without a permissions block', async () => {
    const raw = await readFile(join(fixture('no-selftest'), 'skelm.package.json'), 'utf8')
    const summary = buildPermissionSummary(parsePackageManifest(raw))
    const wf = summary.workflows[0]
    expect(wf?.hasPermissions).toBe(false)
    expect(wf?.allowedExecutables).toEqual([])
    expect(wf?.allowedSecrets).toEqual([])
    expect(wf?.declaresNetworkEgress).toBe(false)
    expect(wf?.requestsUnrestricted).toBe(false)
  })
})
