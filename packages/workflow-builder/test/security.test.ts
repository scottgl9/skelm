// Security: the workflow builder's declared permissions are default-deny and
// project-scoped, and the ProjectSource cannot read outside the project root.
// The builder NEVER holds fsWrite — every write goes through the gateway apply
// route — so there is no in-package write path to test for escape; the read
// path is the structural project-scope boundary.

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, parsePackageManifest } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertInsideProject, createProjectSource } from '../src/project.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('workflow-builder declared permissions (default-deny, project-scoped)', () => {
  const manifest = parsePackageManifest(
    readFileSync(join(PKG_ROOT, 'skelm.package.json'), 'utf8'),
    'skelm.package.json',
  )
  const entry = manifest.skelm.workflows[0]
  if (entry === undefined) throw new Error('manifest declares no workflows')
  const perms = entry.permissions as Record<string, unknown>

  it('the persistent workflow is the package default entry', () => {
    expect(entry.id).toBe('default')
    expect(entry.kind).toBe('persistent')
  })

  it('grants fsRead scoped to the project only', () => {
    expect(perms.fsRead).toEqual(['./'])
  })

  it('grants NO fsWrite — writes go only through the audited apply route', () => {
    expect(perms.fsWrite).toBeUndefined()
  })

  it('declares executables via an explicit profile, not a blanket allow', () => {
    expect(perms.executableProfiles).toEqual(['nodeBuild'])
    expect(perms.allowedExecutables).toBeUndefined()
  })

  it('leaves every other permission dimension undefined (default-deny)', () => {
    // Anything not explicitly granted resolves to deny at runtime.
    expect(perms.networkEgress).toBeUndefined()
    expect(perms.profile).toBeUndefined()
    expect(perms.fsWrite).toBeUndefined()
    // Only these three keys are declared.
    expect(Object.keys(perms).sort()).toEqual(
      ['allowedSkills', 'executableProfiles', 'fsRead'].sort(),
    )
  })
})

describe('ProjectSource cannot read outside the project root', () => {
  let root: string
  let outside: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skelm-wfb-proj-'))
    outside = await mkdtemp(join(tmpdir(), 'skelm-wfb-out-'))
    await mkdir(join(root, 'workflows'), { recursive: true })
    await writeFile(join(root, 'workflows', 'a.workflow.ts'), 'export default {}', 'utf8')
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET', 'utf8')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('refuses an absolute path outside the root', async () => {
    const src = createProjectSource(root)
    await expect(src.readFile(join(outside, 'secret.txt'))).rejects.toBeInstanceOf(ConfigError)
  })

  it('refuses a .. traversal escape', async () => {
    const src = createProjectSource(root)
    await expect(src.readFile(join(root, '..', 'escape.txt'))).rejects.toBeInstanceOf(ConfigError)
  })

  it('allows reading a file inside the root', async () => {
    const src = createProjectSource(root)
    const body = await src.readFile(join(root, 'workflows', 'a.workflow.ts'))
    expect(body).toBe('export default {}')
  })

  it('assertInsideProject rejects escapes and accepts in-root paths', () => {
    expect(() => assertInsideProject(root, join(outside, 'x'))).toThrow(ConfigError)
    expect(() => assertInsideProject(root, join(root, '..', 'x'))).toThrow(ConfigError)
    expect(assertInsideProject(root, join(root, 'sub', 'x'))).toBe(join(root, 'sub', 'x'))
  })
})
