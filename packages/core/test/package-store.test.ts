import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PackageIntegrityError, PackageManifestError } from '../src/errors.js'
import {
  WorkflowPackageStore,
  computePackageIntegrity,
  encodePackageDirName,
} from '../src/packages/store.js'

const HELLO_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'packages', 'hello')

let projectRoot: string
let store: WorkflowPackageStore

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pkg-store-'))
  store = new WorkflowPackageStore(projectRoot)
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('encodePackageDirName', () => {
  it('encodes scoped names into one path segment', () => {
    expect(encodePackageDirName('@skelm/hello')).toBe('@skelm__hello')
    expect(encodePackageDirName('plain')).toBe('plain')
  })
})

describe('WorkflowPackageStore', () => {
  it('installs a local package directory into the cache', async () => {
    const installed = await store.installFromDirectory(HELLO_DIR)
    expect(installed.name).toBe('@skelm/hello')
    expect(installed.version).toBe('0.1.0')
    expect(installed.dir).toBe(join(projectRoot, '.skelm', 'packages', '@skelm__hello', '0.1.0'))
    expect(installed.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(installed.manifest.skelm.workflows[0]?.id).toBe('default')

    const copied = await readFile(join(installed.dir, 'workflows', 'hello.workflow.ts'), 'utf8')
    const original = await readFile(join(HELLO_DIR, 'workflows', 'hello.workflow.ts'), 'utf8')
    expect(copied).toBe(original)
  })

  it('validates the manifest before copying anything into the cache', async () => {
    const source = await mkdtemp(join(tmpdir(), 'skelm-pkg-bad-'))
    try {
      await writeFile(
        join(source, 'skelm.package.json'),
        JSON.stringify({ name: '@skelm/bad', version: '1.0.0', skelm: { apiVersion: 2 } }),
      )
      await writeFile(join(source, 'payload.ts'), 'export const x = 1\n')
      await expect(store.installFromDirectory(source)).rejects.toThrow(PackageManifestError)
      await expect(readdir(join(projectRoot, '.skelm'))).rejects.toThrow()
    } finally {
      await rm(source, { recursive: true, force: true })
    }
  })

  it('rejects a directory without a manifest', async () => {
    const source = await mkdtemp(join(tmpdir(), 'skelm-pkg-empty-'))
    try {
      await expect(store.installFromDirectory(source)).rejects.toThrow(PackageManifestError)
    } finally {
      await rm(source, { recursive: true, force: true })
    }
  })

  it('rejects a manifest whose declared entry file is missing', async () => {
    const source = await mkdtemp(join(tmpdir(), 'skelm-pkg-noentry-'))
    try {
      await writeFile(
        join(source, 'skelm.package.json'),
        JSON.stringify({
          name: '@skelm/no-entry',
          version: '1.0.0',
          skelm: { apiVersion: 1, workflows: [{ id: 'default', entry: 'missing.workflow.ts' }] },
        }),
      )
      await expect(store.installFromDirectory(source)).rejects.toThrow(
        /entry "missing\.workflow\.ts" .* does not exist/,
      )
    } finally {
      await rm(source, { recursive: true, force: true })
    }
  })

  it('rejects a manifest whose declared entry path is a directory', async () => {
    const source = await mkdtemp(join(tmpdir(), 'skelm-pkg-entry-dir-'))
    try {
      await mkdir(join(source, 'workflows'))
      await writeFile(
        join(source, 'skelm.package.json'),
        JSON.stringify({
          name: '@skelm/entry-dir',
          version: '1.0.0',
          skelm: { apiVersion: 1, workflows: [{ id: 'default', entry: 'workflows' }] },
        }),
      )
      await expect(store.installFromDirectory(source)).rejects.toThrow(
        /entry "workflows".*must be a file/,
      )
    } finally {
      await rm(source, { recursive: true, force: true })
    }
  })

  it('rejects packages that contain symbolic links', async () => {
    const source = await mkdtemp(join(tmpdir(), 'skelm-pkg-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'skelm-pkg-symlink-target-'))
    try {
      await mkdir(join(source, 'workflows'))
      await writeFile(join(outside, 'outside.workflow.ts'), 'export default {}\n')
      await symlink(
        join(outside, 'outside.workflow.ts'),
        join(source, 'workflows', 'link.workflow.ts'),
      )
      await writeFile(
        join(source, 'skelm.package.json'),
        JSON.stringify({
          name: '@skelm/symlink',
          version: '1.0.0',
          skelm: {
            apiVersion: 1,
            workflows: [{ id: 'default', entry: 'workflows/link.workflow.ts' }],
          },
        }),
      )
      await expect(store.installFromDirectory(source)).rejects.toThrow(
        /must not contain symbolic links/,
      )
    } finally {
      await rm(source, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('lists and gets installed packages, and remove() deletes them', async () => {
    expect(await store.list()).toEqual([])
    await store.installFromDirectory(HELLO_DIR)

    const listed = await store.list()
    expect(listed.map((p) => `${p.name}@${p.version}`)).toEqual(['@skelm/hello@0.1.0'])

    const got = await store.get('@skelm/hello', '0.1.0')
    expect(got?.manifest.name).toBe('@skelm/hello')
    expect(await store.get('@skelm/hello', '9.9.9')).toBeUndefined()
    expect(await store.get('@skelm/other', '0.1.0')).toBeUndefined()

    expect(await store.remove('@skelm/hello', '0.1.0')).toBe(true)
    expect(await store.remove('@skelm/hello', '0.1.0')).toBe(false)
    expect(await store.list()).toEqual([])
    await expect(readdir(join(projectRoot, '.skelm', 'packages'))).resolves.toEqual([])
  })

  it('reinstalls over an existing version without leaving staging dirs', async () => {
    const first = await store.installFromDirectory(HELLO_DIR)
    const second = await store.installFromDirectory(HELLO_DIR)
    expect(second.integrity).toBe(first.integrity)
    const versions = await readdir(join(projectRoot, '.skelm', 'packages', '@skelm__hello'))
    expect(versions).toEqual(['0.1.0'])
  })

  it('computes a stable integrity hash and detects tampering', async () => {
    const installed = await store.installFromDirectory(HELLO_DIR)
    expect(await computePackageIntegrity(installed.dir)).toBe(installed.integrity)
    expect(await computePackageIntegrity(HELLO_DIR)).toBe(installed.integrity)

    await expect(
      store.verify('@skelm/hello', '0.1.0', installed.integrity),
    ).resolves.toBeUndefined()

    await writeFile(join(installed.dir, 'workflows', 'hello.workflow.ts'), '// tampered\n')
    const after = await computePackageIntegrity(installed.dir)
    expect(after).not.toBe(installed.integrity)

    let thrown: unknown
    try {
      await store.verify('@skelm/hello', '0.1.0', installed.integrity)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PackageIntegrityError)
    const integrityError = thrown as PackageIntegrityError
    expect(integrityError.packageName).toBe('@skelm/hello')
    expect(integrityError.expected).toBe(installed.integrity)
    expect(integrityError.actual).toBe(after)
  })

  it('verify() fails when package contents contain a symbolic link', async () => {
    const installed = await store.installFromDirectory(HELLO_DIR)
    await symlink(
      join(installed.dir, 'workflows', 'hello.workflow.ts'),
      join(installed.dir, 'workflows', 'hello-link.workflow.ts'),
    )

    await expect(store.verify('@skelm/hello', '0.1.0', installed.integrity)).rejects.toThrow(
      /symbolic links/,
    )
  })

  it('verify() fails for a package that is not installed', async () => {
    await expect(store.verify('@skelm/hello', '0.1.0', 'sha256:0')).rejects.toThrow(
      PackageIntegrityError,
    )
  })
})
