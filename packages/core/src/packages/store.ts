// Workflow-package install cache under <projectRoot>/.skelm/packages/.
// Library only: local-directory installs, no network, no code execution.
// Privileged use (fetching, activation) is owned by the gateway in later
// layers; the manifest is always validated before package files are copied.

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PackageIntegrityError, PackageManifestError } from '../errors.js'
import {
  PACKAGE_MANIFEST_FILENAME,
  type WorkflowPackageManifest,
  parsePackageManifest,
} from './manifest.js'

/** A package present in the store's install cache. */
export interface StoredWorkflowPackage {
  name: string
  version: string
  /** Absolute path of the installed package directory. */
  dir: string
  manifest: WorkflowPackageManifest
}

/** Result of an install: the cached package plus its content integrity hash. */
export interface InstalledWorkflowPackage extends StoredWorkflowPackage {
  /** `sha256:<hex>` over sorted relative paths + file bytes. */
  integrity: string
}

/** Encode a package name into a single path segment (`@scope/name` → `@scope__name`). */
export function encodePackageDirName(name: string): string {
  return name.replaceAll('/', '__')
}

async function walkFiles(root: string, prefix = '', out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new PackageManifestError(
        `workflow package contents must not contain symbolic links: ${join(root, rel)}`,
        join(root, rel),
      )
    }
    if (entry.isDirectory()) {
      await walkFiles(root, rel, out)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

/**
 * Deterministic sha256 over a package directory: relative posix paths sorted
 * bytewise, each hashed as `<path>\0<size>\0<bytes>` so file boundaries are
 * unambiguous. Returns `sha256:<hex>`.
 */
export async function computePackageIntegrity(dir: string): Promise<string> {
  const files = (await walkFiles(dir)).sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    const bytes = await readFile(join(dir, rel))
    hash.update(rel)
    hash.update('\0')
    hash.update(String(bytes.byteLength))
    hash.update('\0')
    hash.update(bytes)
  }
  return `sha256:${hash.digest('hex')}`
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function readManifest(dir: string): Promise<WorkflowPackageManifest> {
  const manifestPath = join(dir, PACKAGE_MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    throw new PackageManifestError(
      `no readable ${PACKAGE_MANIFEST_FILENAME} in ${dir}`,
      manifestPath,
    )
  }
  return parsePackageManifest(raw, manifestPath)
}

async function assertPackageEntriesAreFiles(
  sourceDir: string,
  manifest: WorkflowPackageManifest,
): Promise<void> {
  const manifestPath = join(sourceDir, PACKAGE_MANIFEST_FILENAME)
  const entries = manifest.skelm.workflows.map((w) => w.entry)
  if (manifest.skelm.selfTest !== undefined) entries.push(manifest.skelm.selfTest.entry)
  for (const entry of entries) {
    const entryPath = join(sourceDir, entry)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(entryPath)
    } catch {
      throw new PackageManifestError(
        `entry "${entry}" declared by ${manifest.name} does not exist in ${sourceDir}`,
        manifestPath,
      )
    }
    if (info.isSymbolicLink()) {
      throw new PackageManifestError(
        `entry "${entry}" declared by ${manifest.name} must not be a symbolic link`,
        manifestPath,
      )
    }
    if (!info.isFile()) {
      throw new PackageManifestError(
        `entry "${entry}" declared by ${manifest.name} must be a file in ${sourceDir}`,
        manifestPath,
      )
    }
  }
}

/**
 * Install cache for workflow packages, rooted at
 * `<projectRoot>/.skelm/packages/<encoded-name>/<version>/`. Installs are
 * always explicit — nothing is auto-loaded from node_modules.
 */
export class WorkflowPackageStore {
  constructor(readonly projectRoot: string) {}

  get rootDir(): string {
    return join(this.projectRoot, '.skelm', 'packages')
  }

  packageDir(name: string, version: string): string {
    return join(this.rootDir, encodePackageDirName(name), version)
  }

  /**
   * Parse and fully validate a source directory's manifest — including the
   * symlink and entry-file checks — without copying anything into the cache.
   * The gateway calls this so a trust-policy refusal can fire before any
   * package file reaches the store.
   */
  async readSourceManifest(sourceDir: string): Promise<WorkflowPackageManifest> {
    const manifest = await readManifest(sourceDir)
    await walkFiles(sourceDir)
    await assertPackageEntriesAreFiles(sourceDir, manifest)
    return manifest
  }

  /**
   * Copy a local package directory into the cache. The manifest is parsed and
   * validated, and every declared entry file checked for existence, before any
   * file is copied. Re-installing an existing name/version replaces it.
   */
  async installFromDirectory(sourceDir: string): Promise<InstalledWorkflowPackage> {
    const manifest = await this.readSourceManifest(sourceDir)

    const dest = this.packageDir(manifest.name, manifest.version)
    // Staged sibling + rename so a crash mid-copy never leaves a partial
    // install at the final path.
    const staging = `${dest}.staging-${process.pid}-${Date.now()}`
    await mkdir(dirname(dest), { recursive: true })
    try {
      await cp(sourceDir, staging, { recursive: true })
      await rm(dest, { recursive: true, force: true })
      await rename(staging, dest)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }

    const integrity = await computePackageIntegrity(dest)
    return { name: manifest.name, version: manifest.version, dir: dest, manifest, integrity }
  }

  /** Load one installed package; the cached manifest is re-validated before use. */
  async get(name: string, version: string): Promise<StoredWorkflowPackage | undefined> {
    const dir = this.packageDir(name, version)
    if (!(await isDirectory(dir))) return undefined
    const manifest = await readManifest(dir)
    if (manifest.name !== name || manifest.version !== version) {
      throw new PackageManifestError(
        `cached manifest at ${dir} declares ${manifest.name}@${manifest.version}, expected ${name}@${version}`,
        join(dir, PACKAGE_MANIFEST_FILENAME),
      )
    }
    return { name, version, dir, manifest }
  }

  /** List installed packages, sorted by name then version. */
  async list(): Promise<StoredWorkflowPackage[]> {
    if (!(await isDirectory(this.rootDir))) return []
    const out: StoredWorkflowPackage[] = []
    for (const nameEntry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!nameEntry.isDirectory()) continue
      const nameDir = join(this.rootDir, nameEntry.name)
      for (const versionEntry of await readdir(nameDir, { withFileTypes: true })) {
        if (!versionEntry.isDirectory()) continue
        const dir = join(nameDir, versionEntry.name)
        const manifest = await readManifest(dir)
        out.push({ name: manifest.name, version: manifest.version, dir, manifest })
      }
    }
    const key = (p: StoredWorkflowPackage) => `${p.name}\0${p.version}`
    return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  }

  /**
   * Remove an installed version (or, with no version, every installed version
   * of the package). Returns false when nothing was installed.
   */
  async remove(name: string, version?: string): Promise<boolean> {
    const nameDir = join(this.rootDir, encodePackageDirName(name))
    const target = version === undefined ? nameDir : join(nameDir, version)
    if (!(await isDirectory(target))) return false
    await rm(target, { recursive: true, force: true })
    if (version !== undefined && (await isDirectory(nameDir))) {
      const left = await readdir(nameDir)
      if (left.length === 0) await rm(nameDir, { recursive: true, force: true })
    }
    return true
  }

  /**
   * Recompute the cached package's integrity and compare against the expected
   * `sha256:<hex>` value (normally from skelm.lock.json). Throws
   * {@link PackageIntegrityError} when the package is missing or tampered.
   */
  async verify(name: string, version: string, expectedIntegrity: string): Promise<void> {
    const dir = this.packageDir(name, version)
    if (!(await isDirectory(dir))) {
      throw new PackageIntegrityError(
        `${name}@${version} is not installed at ${dir}`,
        name,
        expectedIntegrity,
      )
    }
    let actual: string
    try {
      actual = await computePackageIntegrity(dir)
    } catch (error) {
      if (error instanceof PackageManifestError) {
        throw new PackageIntegrityError(
          `${name}@${version} failed integrity verification: ${error.message}`,
          name,
          expectedIntegrity,
        )
      }
      throw error
    }
    if (actual !== expectedIntegrity) {
      throw new PackageIntegrityError(
        `${name}@${version} failed integrity verification: expected ${expectedIntegrity}, got ${actual}`,
        name,
        expectedIntegrity,
        actual,
      )
    }
  }
}
