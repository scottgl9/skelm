import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PackageManifestError } from '../src/errors.js'
import { parsePackageManifest, validatePackageManifest } from '../src/packages/manifest.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'packages')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

function valid(): Record<string, unknown> {
  return JSON.parse(fixture('hello/skelm.package.json'))
}

function expectRejects(value: unknown, messagePart: string): void {
  let thrown: unknown
  try {
    validatePackageManifest(value, 'skelm.package.json')
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(PackageManifestError)
  expect((thrown as PackageManifestError).message).toContain(messagePart)
}

describe('parsePackageManifest', () => {
  it('parses the valid @skelm/hello fixture', () => {
    const manifest = parsePackageManifest(fixture('hello/skelm.package.json'))
    expect(manifest.name).toBe('@skelm/hello')
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.skelm.apiVersion).toBe(1)
    expect(manifest.skelm.requiredSkelmVersion).toBe('>=0.4.0')
    expect(manifest.skelm.workflows).toEqual([
      {
        id: 'default',
        entry: 'workflows/hello.workflow.ts',
        kind: 'pipeline',
        description: 'Greets someone by name.',
      },
    ])
    expect(manifest.skelm.secrets).toEqual([
      { name: 'HELLO_TOKEN', description: 'Example secret reference.' },
    ])
    expect(manifest.skelm.triggers).toEqual([
      { id: 'daily', kind: 'cron', description: 'Daily greeting.' },
    ])
  })

  it('rejects malformed JSON with a typed error', () => {
    let thrown: unknown
    try {
      parsePackageManifest('{ not json', 'skelm.package.json')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PackageManifestError)
    expect((thrown as PackageManifestError).message).toContain('malformed JSON')
    expect((thrown as PackageManifestError).source).toBe('skelm.package.json')
  })
})

describe('validatePackageManifest', () => {
  it('rejects non-object roots', () => {
    expectRejects('nope', 'manifest must be a JSON object')
    expectRejects([], 'manifest must be a JSON object')
    expectRejects(null, 'manifest must be a JSON object')
  })

  it('rejects the bad-name fixture and other invalid npm names', () => {
    expectRejects(JSON.parse(fixture('invalid/bad-name.json')), 'not a valid npm package name')
    for (const name of [
      'UPPER',
      '.hidden',
      '_under',
      '@scope',
      'a b',
      '@/x',
      `x${'a'.repeat(214)}`,
    ]) {
      expectRejects({ ...valid(), name }, 'not a valid npm package name')
    }
  })

  it('rejects a missing or non-semver version', () => {
    expectRejects({ ...valid(), version: undefined }, '`version` must be a non-empty string')
    for (const version of ['1.0', 'v1.0.0', '1.0.0.0', '01.0.0', 'latest']) {
      expectRejects({ ...valid(), version }, 'must be an exact semver version')
    }
  })

  it('rejects non-string optional metadata and bad repository shapes', () => {
    expectRejects({ ...valid(), description: 5 }, '`description` must be a string')
    expectRejects({ ...valid(), license: [] }, '`license` must be a string')
    expectRejects({ ...valid(), homepage: 1 }, '`homepage` must be a string')
    expectRejects({ ...valid(), repository: 7 }, '`repository` must be a string or object')
  })

  it('rejects a missing skelm section', () => {
    expectRejects({ ...valid(), skelm: undefined }, 'must declare a `skelm` object')
  })

  it('rejects the bad-api-version fixture and other apiVersion values', () => {
    expectRejects(
      JSON.parse(fixture('invalid/bad-api-version.json')),
      '`skelm.apiVersion` must be 1',
    )
    const m = valid()
    expectRejects({ ...m, skelm: { ...(m.skelm as object), apiVersion: '1' } }, 'must be 1')
  })

  it('rejects a non-string requiredSkelmVersion', () => {
    const m = valid()
    expectRejects(
      { ...m, skelm: { ...(m.skelm as object), requiredSkelmVersion: 1 } },
      '`skelm.requiredSkelmVersion` must be a string',
    )
  })

  function withWorkflows(workflows: unknown): Record<string, unknown> {
    const m = valid()
    return { ...m, skelm: { ...(m.skelm as object), workflows } }
  }

  it('rejects missing or non-array workflows', () => {
    expectRejects(withWorkflows(undefined), '`skelm.workflows` must be an array')
    expectRejects(withWorkflows({}), '`skelm.workflows` must be an array')
  })

  it('rejects workflow entries with bad ids', () => {
    expectRejects(withWorkflows(['x']), '`skelm.workflows[0]` must be an object')
    expectRejects(
      withWorkflows([{ entry: 'a.ts' }]),
      '`skelm.workflows[0].id` must be a non-empty string',
    )
    expectRejects(withWorkflows([{ id: '', entry: 'a.ts' }]), 'non-empty string')
  })

  it('rejects the duplicate-ids fixture', () => {
    expectRejects(JSON.parse(fixture('invalid/duplicate-ids.json')), 'duplicate id "default"')
  })

  it('rejects the path-escape fixture and other escaping entry paths', () => {
    expectRejects(
      JSON.parse(fixture('invalid/path-escape.json')),
      'must not escape the package root',
    )
    expectRejects(
      withWorkflows([{ id: 'a', entry: '/etc/passwd' }]),
      'must be a package-relative path, not absolute',
    )
    expectRejects(withWorkflows([{ id: 'a', entry: 'C:/evil.ts' }]), 'not absolute')
    expectRejects(withWorkflows([{ id: 'a', entry: 'a/../../evil.ts' }]), 'must not escape')
    expectRejects(withWorkflows([{ id: 'a', entry: '..\\evil.ts' }]), 'must use forward slashes')
    expectRejects(withWorkflows([{ id: 'a', entry: '' }]), 'non-empty string')
  })

  it('rejects unknown workflow kinds and non-object permissions', () => {
    expectRejects(
      withWorkflows([{ id: 'a', entry: 'a.ts', kind: 'daemon' }]),
      "must be 'pipeline' or 'persistent'",
    )
    expectRejects(
      withWorkflows([{ id: 'a', entry: 'a.ts', permissions: 'all' }]),
      '`skelm.workflows[0].permissions` must be an object',
    )
    expectRejects(
      withWorkflows([{ id: 'a', entry: 'a.ts', description: 1 }]),
      '`skelm.workflows[0].description` must be a string',
    )
  })

  function withSkelm(patch: Record<string, unknown>): Record<string, unknown> {
    const m = valid()
    return { ...m, skelm: { ...(m.skelm as object), ...patch } }
  }

  it('rejects malformed secrets', () => {
    expectRejects(withSkelm({ secrets: {} }), '`skelm.secrets` must be an array')
    expectRejects(withSkelm({ secrets: ['TOKEN'] }), '`skelm.secrets[0]` must be an object')
    expectRejects(
      withSkelm({ secrets: [{}] }),
      '`skelm.secrets[0].name` must be a non-empty string',
    )
  })

  it('rejects malformed string-array sections', () => {
    expectRejects(withSkelm({ integrations: 'github' }), '`skelm.integrations` must be an array')
    expectRejects(withSkelm({ stateNamespaces: [1] }), '`skelm.stateNamespaces` must be an array')
    expectRejects(withSkelm({ artifacts: [''] }), '`skelm.artifacts` must be an array')
  })

  it('rejects malformed triggers', () => {
    expectRejects(withSkelm({ triggers: {} }), '`skelm.triggers` must be an array')
    expectRejects(
      withSkelm({ triggers: [{ id: 'a' }] }),
      '`skelm.triggers[0].kind` must be a non-empty string',
    )
    expectRejects(
      withSkelm({ triggers: [{ kind: 'cron' }] }),
      '`skelm.triggers[0].id` must be a non-empty string',
    )
  })

  it('rejects malformed selfTest, config, and dashboard sections', () => {
    expectRejects(withSkelm({ selfTest: 'test.ts' }), '`skelm.selfTest` must be an object')
    expectRejects(withSkelm({ selfTest: { entry: '../t.ts' } }), 'must not escape')
    expectRejects(withSkelm({ config: [] }), '`skelm.config` must be an object')
    expectRejects(withSkelm({ dashboard: 'yes' }), '`skelm.dashboard` must be an object')
  })

  it('tolerates extra top-level npm fields', () => {
    const manifest = validatePackageManifest({ ...valid(), keywords: ['x'], private: false })
    expect(manifest.name).toBe('@skelm/hello')
  })
})
