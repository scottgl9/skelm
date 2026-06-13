// skelm.lock.json — project-root, source-controlled record of installed
// workflow packages. Serialization is deterministic (sorted package keys,
// fixed field order) so lockfile diffs stay reviewable, and writes are
// atomic via tmp+rename.

import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigError } from '../errors.js'
import { ALL_PACKAGE_TRUST_LEVELS, type PackageTrustLevel } from './trust.js'

/** Lockfile filename at the project root. */
export const SKELM_LOCKFILE_NAME = 'skelm.lock.json'

/** One installed package as recorded in skelm.lock.json. */
export interface SkelmLockfileEntry {
  name: string
  version: string
  /** Resolved source: a local directory path or (later) a tarball URL. */
  resolved: string
  /** `sha256:<hex>` content hash of the installed package. */
  integrity: string
  /** ISO 8601 timestamp of the install. */
  installedAt: string
  requiredSkelmVersion?: string
  /** Trust level derived from the install source; recorded for later review. */
  trustLevel?: PackageTrustLevel
}

export interface SkelmLockfile {
  lockfileVersion: 1
  /** Entries keyed by package name. */
  packages: Record<string, SkelmLockfileEntry>
}

function emptyLockfile(): SkelmLockfile {
  return { lockfileVersion: 1, packages: {} }
}

function invalid(message: string): never {
  throw new ConfigError(`${SKELM_LOCKFILE_NAME}: ${message}`, SKELM_LOCKFILE_NAME)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateEntry(name: string, value: unknown): SkelmLockfileEntry {
  if (!isPlainObject(value)) invalid(`entry "${name}" must be an object`)
  for (const field of ['name', 'version', 'resolved', 'integrity', 'installedAt'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      invalid(`entry "${name}" is missing a string \`${field}\``)
    }
  }
  if (value.requiredSkelmVersion !== undefined && typeof value.requiredSkelmVersion !== 'string') {
    invalid(`entry "${name}" has a non-string \`requiredSkelmVersion\``)
  }
  if (
    value.trustLevel !== undefined &&
    !ALL_PACKAGE_TRUST_LEVELS.includes(value.trustLevel as PackageTrustLevel)
  ) {
    invalid(`entry "${name}" has an invalid \`trustLevel\`: ${JSON.stringify(value.trustLevel)}`)
  }
  return value as unknown as SkelmLockfileEntry
}

/**
 * Read the project's lockfile. A missing file yields an empty lockfile;
 * malformed content throws {@link ConfigError}.
 */
export async function readLockfile(projectRoot: string): Promise<SkelmLockfile> {
  let raw: string
  try {
    raw = await readFile(join(projectRoot, SKELM_LOCKFILE_NAME), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyLockfile()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    invalid(`malformed JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isPlainObject(parsed)) invalid('must be a JSON object')
  if (parsed.lockfileVersion !== 1) {
    invalid(`\`lockfileVersion\` must be 1; got ${JSON.stringify(parsed.lockfileVersion)}`)
  }
  if (!isPlainObject(parsed.packages)) invalid('`packages` must be an object')
  const packages: Record<string, SkelmLockfileEntry> = {}
  for (const [name, entry] of Object.entries(parsed.packages)) {
    packages[name] = validateEntry(name, entry)
  }
  return { lockfileVersion: 1, packages }
}

function serializeLockfile(lockfile: SkelmLockfile): string {
  const packages: Record<string, SkelmLockfileEntry> = {}
  const entries = Object.entries(lockfile.packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [name, e] of entries) {
    packages[name] = {
      name: e.name,
      version: e.version,
      resolved: e.resolved,
      integrity: e.integrity,
      installedAt: e.installedAt,
      ...(e.requiredSkelmVersion !== undefined && {
        requiredSkelmVersion: e.requiredSkelmVersion,
      }),
      ...(e.trustLevel !== undefined && { trustLevel: e.trustLevel }),
    }
  }
  return `${JSON.stringify({ lockfileVersion: 1, packages }, null, 2)}\n`
}

/** Write the lockfile atomically (tmp file + rename) with stable key ordering. */
export async function writeLockfile(projectRoot: string, lockfile: SkelmLockfile): Promise<void> {
  const path = join(projectRoot, SKELM_LOCKFILE_NAME)
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await writeFile(tmp, serializeLockfile(lockfile), 'utf8')
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Read-modify-write: upsert one package entry. Returns the updated lockfile. */
export async function updateLockfileEntry(
  projectRoot: string,
  entry: SkelmLockfileEntry,
): Promise<SkelmLockfile> {
  const lockfile = await readLockfile(projectRoot)
  lockfile.packages[entry.name] = entry
  await writeLockfile(projectRoot, lockfile)
  return lockfile
}

/** Read-modify-write: drop one package entry. Returns the updated lockfile. */
export async function removeLockfileEntry(
  projectRoot: string,
  name: string,
): Promise<SkelmLockfile> {
  const lockfile = await readLockfile(projectRoot)
  delete lockfile.packages[name]
  await writeLockfile(projectRoot, lockfile)
  return lockfile
}
