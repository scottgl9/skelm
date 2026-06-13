import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  DEFAULT_PACKAGE_TRUST_POLICY,
  EMPTY_PACKAGE_PERMISSION_SUMMARY,
  PackageIntegrityError,
  PackageManifestError,
  type PackagePermissionExpansion,
  type PackageTrustPolicy,
  type SkelmLockfileEntry,
  WorkflowPackageStore,
  computePackageIntegrity,
  derivePackageTrustLevel,
  diffPackagePermissions,
  evaluatePackageTrust,
  readLockfile,
  removeLockfileEntry,
  summarizePackagePermissions,
  updateLockfileEntry,
} from '@skelm/core'
import { type Router, createError, eventHandler, getQuery, readBody } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'
import { decodeMaybe } from './utils.js'

/**
 * Workflow-package control surface. Backed by the project's
 * `WorkflowPackageStore` (install cache under `.skelm/packages/`) and the
 * source-controlled `skelm.lock.json`. The store and lockfile helpers are
 * core libraries; this route is the gateway-owned privileged surface that
 * audits every mutation and surfaces typed errors as safe HTTP responses.
 *
 *   GET    /v1/packages            — installed packages + lockfile data
 *   GET    /v1/packages/:name      — one package: manifest, versions, lock entry
 *   POST   /v1/packages/install    — install from a local dir or local .tgz
 *   DELETE /v1/packages/:name      — remove (optionally a single ?version=)
 *
 * Remote (npm-registry / URL) installs are out of scope this slice pending a
 * network-egress policy decision; only local directory and local tarball
 * sources are accepted.
 */
export function registerPackageRoutes(router: Router, gateway: GatewayContext): void {
  const projectRoot = gateway.projectRoot
  const store = new WorkflowPackageStore(projectRoot)

  router.get(
    '/v1/packages',
    eventHandler(async () => {
      const [installed, lockfile] = await Promise.all([store.list(), readLockfile(projectRoot)])
      return {
        packages: installed.map((p) => ({
          name: p.name,
          version: p.version,
          description: p.manifest.description,
          lock: lockfile.packages[p.name] ?? null,
        })),
      }
    }),
  )

  router.get(
    '/v1/packages/:name',
    eventHandler(async (event) => {
      const name = readName(event.context.params?.name)
      const [installed, lockfile] = await Promise.all([store.list(), readLockfile(projectRoot)])
      const versions = installed.filter((p) => p.name === name)
      const lock = lockfile.packages[name] ?? null
      if (versions.length === 0 && lock === null) {
        throw createError({ statusCode: 404, message: `package ${name} is not installed` })
      }
      // The manifest of the version recorded in the lockfile, else the
      // highest-sorted installed version.
      const primary =
        versions.find((p) => p.version === lock?.version) ?? versions[versions.length - 1]
      let integrity: string | undefined
      if (primary !== undefined) {
        integrity = await computePackageIntegrity(primary.dir)
      }
      return {
        name,
        ...(primary !== undefined && { manifest: primary.manifest }),
        versions: versions.map((p) => p.version),
        ...(integrity !== undefined && { integrity }),
        ...(lock?.trustLevel !== undefined && { trustLevel: lock.trustLevel }),
        ...(primary !== undefined && {
          permissions: summarizePackagePermissions(primary.manifest),
        }),
        lock,
      }
    }),
  )

  router.post(
    '/v1/packages/install',
    eventHandler(async (event) => {
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object'
          ? (rawBody as { source?: unknown; approve?: unknown })
          : {}
      if (typeof body.source !== 'string' || body.source.length === 0) {
        throw createError({ statusCode: 400, message: 'source: must be a non-empty string' })
      }
      const source = body.source
      const approve = body.approve === true

      // A tarball source is staged into a temp dir, validated, then installed
      // from there; otherwise the source is treated as a local directory.
      const sourceInfo = classifyPackageInstallSource(source)
      const trustLevel = derivePackageTrustLevel(
        source,
        sourceInfo.registryOrigin === undefined
          ? { isTarball: sourceInfo.isLocalTarball }
          : {
              isTarball: sourceInfo.isLocalTarball,
              registryOrigin: sourceInfo.registryOrigin,
            },
      )
      const policy = resolveTrustPolicy(gateway)

      let installDir = source
      let cleanup: (() => Promise<void>) | undefined
      if (sourceInfo.isLocalTarball) {
        const staged = await stageTarball(source)
        installDir = staged.dir
        cleanup = staged.cleanup
      }

      if (sourceInfo.registryOrigin !== undefined) {
        const trustDecision = evaluatePackageTrust(trustLevel, policy)
        if (trustDecision === 'denied') {
          await gateway.enforcement.auditWriter.write({
            actor: 'gateway',
            action: 'package.install.refused',
            details: {
              source,
              trustLevel,
              reason: 'trust-level-denied',
            },
          })
          throw createError({
            statusCode: 403,
            message: `package source ${source} has trust level "${trustLevel}", which the trust policy denies`,
          })
        }
        if (trustDecision === 'requires-approval' && !approve) {
          await gateway.enforcement.auditWriter.write({
            actor: 'gateway',
            action: 'package.install.pending',
            details: {
              source,
              trustLevel,
              reason: 'trust-level-requires-approval',
            },
          })
          throw createError({
            statusCode: 409,
            message: `package source ${source} has trust level "${trustLevel}", which requires explicit approval; re-send with { "approve": true }`,
          })
        }
        throw createError({
          statusCode: 400,
          message:
            'remote package installs are not yet supported; source must be a local directory or local .tgz tarball',
        })
      }

      try {
        // Validate the manifest before any trust decision so a malformed
        // package fails the same way regardless of policy, and so a refusal can
        // name the package and fire BEFORE any file reaches the cache.
        const manifest = await store.readSourceManifest(installDir)

        // Trust-level gate: a level the policy does not allow is refused, or held
        // pending until an explicit approval, before the package activates.
        const trustDecision = evaluatePackageTrust(trustLevel, policy)
        if (trustDecision === 'denied') {
          await gateway.enforcement.auditWriter.write({
            actor: 'gateway',
            action: 'package.install.refused',
            details: {
              name: manifest.name,
              version: manifest.version,
              trustLevel,
              reason: 'trust-level-denied',
            },
          })
          throw createError({
            statusCode: 403,
            message: `package ${manifest.name}@${manifest.version} has trust level "${trustLevel}", which the trust policy denies`,
          })
        }
        if (trustDecision === 'requires-approval' && !approve) {
          await gateway.enforcement.auditWriter.write({
            actor: 'gateway',
            action: 'package.install.pending',
            details: {
              name: manifest.name,
              version: manifest.version,
              trustLevel,
              reason: 'trust-level-requires-approval',
            },
          })
          throw createError({
            statusCode: 409,
            message: `package ${manifest.name}@${manifest.version} has trust level "${trustLevel}", which requires explicit approval; re-send with { "approve": true }`,
          })
        }

        // Permission-expansion gate on UPDATE: when a version of this package is
        // already recorded, flag any broadening of the requested permission /
        // secret / trigger surface. An expansion needs its own approval so a
        // package can never silently widen its reach across an update.
        const priorLock = (await readLockfile(projectRoot)).packages[manifest.name]
        let expansion: PackagePermissionExpansion | undefined
        if (priorLock !== undefined) {
          // Diff against the installed baseline when its manifest is available.
          // If the lockfile records a version whose cached files are gone (e.g.
          // that version was removed but another remains installed, so the lock
          // entry persists), the baseline is unknown — fail closed by diffing
          // against an empty surface so any requested permission counts as an
          // expansion. Otherwise an update could silently widen its reach.
          const prior = await store.get(priorLock.name, priorLock.version)
          const priorSummary =
            prior !== undefined
              ? summarizePackagePermissions(prior.manifest)
              : EMPTY_PACKAGE_PERMISSION_SUMMARY
          expansion = diffPackagePermissions(priorSummary, summarizePackagePermissions(manifest))
          if (expansion.expanded && !approve) {
            await gateway.enforcement.auditWriter.write({
              actor: 'gateway',
              action: 'package.update.flagged',
              details: {
                name: manifest.name,
                fromVersion: priorLock.version,
                toVersion: manifest.version,
                baselineKnown: prior !== undefined,
                expansion,
              },
            })
            throw createError({
              statusCode: 409,
              message: `update of ${manifest.name} to ${manifest.version} expands its requested permissions; re-send with { "approve": true } to approve`,
            })
          }
        }

        const result = await store.installFromDirectory(installDir)
        const entry: SkelmLockfileEntry = {
          name: result.name,
          version: result.version,
          resolved: source,
          integrity: result.integrity,
          installedAt: new Date().toISOString(),
          trustLevel,
          ...(manifest.skelm.requiredSkelmVersion !== undefined && {
            requiredSkelmVersion: manifest.skelm.requiredSkelmVersion,
          }),
        }
        await updateLockfileEntry(projectRoot, entry)
        await gateway.enforcement.auditWriter.write({
          actor: 'gateway',
          action: 'package.install',
          details: {
            name: result.name,
            version: result.version,
            integrity: result.integrity,
            source: sourceInfo.isLocalTarball ? 'tarball' : 'directory',
            trustLevel,
            ...(approve && trustDecision === 'requires-approval' && { approved: true }),
            ...(expansion?.expanded === true && { expansion, expansionApproved: approve }),
          },
        })
        return {
          installed: {
            name: result.name,
            version: result.version,
            integrity: result.integrity,
            trustLevel,
            permissions: summarizePackagePermissions(manifest),
            ...(expansion?.expanded === true && { expansion }),
          },
        }
      } catch (err) {
        if (err instanceof PackageManifestError || err instanceof PackageIntegrityError) {
          throw createError({ statusCode: 400, message: err.message })
        }
        throw err
      } finally {
        await cleanup?.()
      }
    }),
  )

  router.post(
    '/v1/packages/resolve',
    eventHandler(async (event) => {
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object' ? (rawBody as { spec?: unknown }) : {}
      if (typeof body.spec !== 'string' || body.spec.length === 0) {
        throw createError({ statusCode: 400, message: 'spec: must be a non-empty string' })
      }
      return await resolvePackageSpec(store, projectRoot, body.spec)
    }),
  )

  router.delete(
    '/v1/packages/:name',
    eventHandler(async (event) => {
      const name = readName(event.context.params?.name)
      const q = getQuery(event)
      const version = typeof q.version === 'string' && q.version.length > 0 ? q.version : undefined
      const removed = await store.remove(name, version)
      if (!removed) {
        throw createError({
          statusCode: 404,
          message:
            version === undefined
              ? `package ${name} is not installed`
              : `package ${name}@${version} is not installed`,
        })
      }
      // Drop the lockfile entry only when no version of the package remains
      // installed (removing one of several versions keeps the record).
      const stillInstalled = (await store.list()).some((p) => p.name === name)
      if (!stillInstalled) await removeLockfileEntry(projectRoot, name)
      await gateway.enforcement.auditWriter.write({
        actor: 'gateway',
        action: 'package.remove',
        details: { name, ...(version !== undefined && { version }) },
      })
      return { removed: true, name, ...(version !== undefined && { version }) }
    }),
  )
}

/** Parsed components of a workflow-package run spec. */
export interface ParsedPackageSpec {
  name: string
  version?: string
  entryId: string
}

/**
 * Split a run spec into name / version / entry id. Grammar (forward slashes):
 *   @scope/name              @scope/name@1.2.3              name
 *   @scope/name/entry        @scope/name@1.2.3/entry        name@1.2.3/entry
 * A scoped name always starts with `@` and contains exactly one slash before
 * any optional `/entry`. The entry id defaults to `default`.
 */
export function parsePackageSpec(spec: string): ParsedPackageSpec {
  let rest = spec
  let name: string
  if (rest.startsWith('@')) {
    const slash = rest.indexOf('/')
    if (slash < 0) {
      throw createError({ statusCode: 400, message: `invalid package spec: ${spec}` })
    }
    const secondSlash = rest.indexOf('/', slash + 1)
    if (secondSlash < 0) {
      name = rest
      rest = ''
    } else {
      name = rest.slice(0, secondSlash)
      rest = rest.slice(secondSlash + 1)
    }
  } else {
    const slash = rest.indexOf('/')
    if (slash < 0) {
      name = rest
      rest = ''
    } else {
      name = rest.slice(0, slash)
      rest = rest.slice(slash + 1)
    }
  }
  // A trailing `@version` lives on the name segment.
  const at = name.lastIndexOf('@')
  let version: string | undefined
  if (at > 0) {
    version = name.slice(at + 1)
    name = name.slice(0, at)
  }
  const entryId = rest.length > 0 ? rest : 'default'
  return { name, ...(version !== undefined && { version }), entryId }
}

/**
 * Resolve a run spec to the absolute entry file of an installed package
 * workflow. Picks the requested version, or the single installed version
 * when none is given (ambiguity is an error). A missing entry id lists the
 * available ids so the caller can correct it.
 */
export async function resolvePackageSpec(
  store: WorkflowPackageStore,
  projectRoot: string,
  spec: string,
): Promise<{ file: string; name: string; version: string; entryId: string }> {
  const parsed = parsePackageSpec(spec)
  const installed = (await store.list()).filter((p) => p.name === parsed.name)
  if (installed.length === 0) {
    throw createError({ statusCode: 404, message: `package ${parsed.name} is not installed` })
  }
  let chosen = installed.find((p) => p.version === parsed.version)
  if (parsed.version !== undefined && chosen === undefined) {
    throw createError({
      statusCode: 404,
      message: `package ${parsed.name}@${parsed.version} is not installed`,
    })
  }
  if (chosen === undefined) {
    if (installed.length > 1) {
      throw createError({
        statusCode: 400,
        message: `multiple versions of ${parsed.name} are installed (${installed
          .map((p) => p.version)
          .join(', ')}); specify one as ${parsed.name}@<version>`,
      })
    }
    chosen = installed[0]
  }
  const pkg = chosen
  if (pkg === undefined) {
    throw createError({ statusCode: 404, message: `package ${parsed.name} is not installed` })
  }
  const workflow = pkg.manifest.skelm.workflows.find((w) => w.id === parsed.entryId)
  if (workflow === undefined) {
    const ids = pkg.manifest.skelm.workflows.map((w) => w.id).join(', ')
    throw createError({
      statusCode: 404,
      message: `package ${pkg.name}@${pkg.version} has no workflow "${parsed.entryId}"; available: ${ids}`,
    })
  }
  const lock = (await readLockfile(projectRoot)).packages[pkg.name]
  if (lock === undefined) {
    throw createError({
      statusCode: 409,
      message: `package ${pkg.name}@${pkg.version} has no lockfile integrity record`,
    })
  }
  try {
    await store.verify(pkg.name, pkg.version, lock.integrity)
  } catch (err) {
    if (err instanceof PackageIntegrityError) {
      throw createError({ statusCode: 409, message: err.message })
    }
    throw err
  }
  return {
    file: join(pkg.dir, workflow.entry),
    name: pkg.name,
    version: pkg.version,
    entryId: workflow.id,
  }
}

function readName(raw: string | undefined): string {
  const name = decodeMaybe(raw)
  if (name === undefined || name.length === 0) {
    throw createError({ statusCode: 400, message: 'package name required' })
  }
  return name
}

/**
 * The operator trust policy from gateway config, falling back to the
 * conservative default (local + workspace allowed; registry levels require
 * approval; unknown denied).
 */
function resolveTrustPolicy(gateway: GatewayContext): PackageTrustPolicy {
  return gateway.getConfig().defaults?.packageTrust ?? DEFAULT_PACKAGE_TRUST_POLICY
}

interface StagedTarball {
  dir: string
  cleanup: () => Promise<void>
}

interface PackageInstallSourceInfo {
  isLocalTarball: boolean
  registryOrigin?: 'npm' | 'private'
}

function classifyPackageInstallSource(source: string): PackageInstallSourceInfo {
  const tarball = /\.(tgz|tar\.gz)(?:[?#].*)?$/i.test(source)
  if (!tarball) return { isLocalTarball: false }
  const remote = readRemoteTarballUrl(source)
  if (remote === undefined) return { isLocalTarball: true }
  return {
    isLocalTarball: false,
    registryOrigin: remote.hostname === 'registry.npmjs.org' ? 'npm' : 'private',
  }
}

function readRemoteTarballUrl(source: string): URL | undefined {
  try {
    const url = new URL(source)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract a local `.tgz` into a fresh temp directory. Entries with absolute
 * paths or `..` traversal segments are rejected before anything is written —
 * the path-traversal guard for tarball installs. Returns the staging dir and
 * a cleanup that removes it.
 */
async function stageTarball(tarballPath: string): Promise<StagedTarball> {
  let gz: Buffer
  try {
    gz = await readFile(tarballPath)
  } catch {
    throw createError({ statusCode: 400, message: `cannot read tarball: ${tarballPath}` })
  }
  let tar: Buffer
  try {
    tar = gunzipSync(gz)
  } catch (err) {
    throw createError({
      statusCode: 400,
      message: `failed to gunzip tarball: ${(err as Error).message}`,
    })
  }
  const entries = parseTar(tar)
  const dir = await mkdtemp(join(tmpdir(), 'skelm-pkg-install-'))
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  }
  try {
    // npm pack tarballs nest everything under a top-level `package/` dir;
    // strip a single leading segment when every entry shares it so the
    // manifest lands at the staging root.
    const stripPrefix = commonPackagePrefix(entries)
    for (const entry of entries) {
      const rel = stripPrefix !== undefined ? entry.name.slice(stripPrefix.length) : entry.name
      if (rel.length === 0) continue
      assertSafeRelative(rel)
      const target = join(dir, rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.data)
    }
    return { dir, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

function commonPackagePrefix(entries: TarEntry[]): string | undefined {
  if (entries.length === 0) return undefined
  const first = entries[0]?.name ?? ''
  const slash = first.indexOf('/')
  if (slash < 0) return undefined
  const prefix = first.slice(0, slash + 1)
  return entries.every((e) => e.name.startsWith(prefix)) ? prefix : undefined
}

function assertSafeRelative(rel: string): void {
  const normalized = normalize(rel)
  if (
    isAbsolute(normalized) ||
    normalized.startsWith('..') ||
    normalized.split(/[\\/]/).includes('..') ||
    normalized.startsWith(sep) ||
    normalized.startsWith('/')
  ) {
    throw createError({
      statusCode: 400,
      message: `tarball entry escapes the package root: ${rel}`,
    })
  }
}

interface TarEntry {
  name: string
  data: Buffer
}

/**
 * Minimal ustar reader: 512-byte header blocks + 512-padded file bodies.
 * Handles regular files (typeflag '0'/'\0') and the GNU/PAX long-name
 * extensions enough to read npm-pack output; directories and other types are
 * skipped. No dependency — the tarball surface is small and gateway-owned.
 */
function parseTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  let offset = 0
  let pendingLongName: string | undefined
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    // Two consecutive zero blocks mark the archive end.
    if (header.every((b) => b === 0)) break
    const name = readTarString(header, 0, 100)
    const sizeOctal = readTarString(header, 124, 12).trim()
    const size = sizeOctal === '' ? 0 : Number.parseInt(sizeOctal, 8)
    if (!Number.isFinite(size) || size < 0) {
      throw createError({ statusCode: 400, message: 'malformed tar header (size)' })
    }
    const typeFlag = String.fromCharCode(header[156] ?? 0)
    const bodyStart = offset + 512
    const body = buf.subarray(bodyStart, bodyStart + size)
    const padded = Math.ceil(size / 512) * 512
    offset = bodyStart + padded

    if (typeFlag === 'L') {
      // GNU long name: the body is the real name for the next entry.
      pendingLongName = body.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      const entryName = (pendingLongName ?? name).replace(/\0+$/, '')
      pendingLongName = undefined
      if (entryName.length > 0 && !entryName.endsWith('/')) {
        out.push({ name: entryName, data: Buffer.from(body) })
      }
    } else {
      pendingLongName = undefined
    }
  }
  return out
}

function readTarString(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString('utf8')
}
