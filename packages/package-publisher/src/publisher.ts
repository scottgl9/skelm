// The publish pipeline, as plain async functions so they are unit-testable and
// runnable from a workflow code step. NOTHING here performs a real npm publish
// or any network/privileged action: it reads the target package directory,
// validates, summarizes, secret-scans, optionally validates the declared
// self-test entry, and assembles a publish DRY-RUN. Actual publishing is out
// of scope.

import { readFile, readdir, stat } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { join, relative, sep } from 'node:path'
import {
  PACKAGE_MANIFEST_FILENAME,
  PackageManifestError,
  type WorkflowPackageManifest,
  computePackageIntegrity,
  parsePackageManifest,
} from '@skelm/core'
import { init, parse } from 'es-module-lexer'
import { type SecretFinding, scanText } from './secret-scan.js'
import type {
  DryRunFile,
  DryRunReport,
  PermissionSummary,
  PublishOptions,
  PublishReport,
  PublishStages,
  SelfTestResult,
  WorkflowPermissionSummary,
} from './types.js'

// Directories that are never package content for scan/dry-run purposes.
const SKIP_DIRS = new Set(['node_modules', '.skelm', 'dist', '.git'])
// Extensions whose bytes we never decode as text for the secret scan (binaries).
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.wasm',
  '.woff',
  '.woff2',
])
const exportLexerReady = init

async function walk(root: string, prefix = '', out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(root, rel, out)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot).toLowerCase()
}

function asPermissions(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Build the references-only permission summary from a validated manifest. */
export function buildPermissionSummary(manifest: WorkflowPackageManifest): PermissionSummary {
  const workflows: WorkflowPermissionSummary[] = manifest.skelm.workflows.map((w) => {
    const p = asPermissions(w.permissions)
    return {
      id: w.id,
      entry: w.entry,
      kind: w.kind ?? 'pipeline',
      hasPermissions: w.permissions !== undefined,
      executableProfiles: stringArray(p.executableProfiles),
      allowedExecutables: stringArray(p.allowedExecutables),
      declaresNetworkEgress: p.networkEgress !== undefined,
      fsRead: stringArray(p.fsRead),
      fsWrite: stringArray(p.fsWrite),
      allowedSecrets: stringArray(p.allowedSecrets),
      requestsUnrestricted: p.requestUnrestricted === true,
    }
  })
  return {
    workflows,
    declaredSecrets: (manifest.skelm.secrets ?? []).map((s) => s.name),
    integrations: [...(manifest.skelm.integrations ?? [])],
    triggers: (manifest.skelm.triggers ?? []).map((t) => ({ id: t.id, kind: t.kind })),
    stateNamespaces: [...(manifest.skelm.stateNamespaces ?? [])],
  }
}

/**
 * Secret-scan every text file under the package directory. Returns redacted
 * findings; raw values are never read into the result.
 */
export async function scanPackageForSecrets(packageDir: string): Promise<SecretFinding[]> {
  const files = (await walk(packageDir)).sort()
  const findings: SecretFinding[] = []
  for (const rel of files) {
    if (BINARY_EXT.has(extOf(rel))) continue
    const bytes = await readFile(join(packageDir, rel))
    // Skip files that look binary (NUL byte in the first chunk).
    if (bytes.subarray(0, 4096).includes(0)) continue
    findings.push(...scanText(rel, bytes.toString('utf8')))
  }
  return findings
}

/** Assemble what a publish would ship: file list, sizes, integrity. Never publishes. */
export async function buildDryRun(
  packageDir: string,
  manifest: WorkflowPackageManifest,
): Promise<DryRunReport> {
  const rels = (await walk(packageDir)).sort()
  const files: DryRunFile[] = []
  let totalBytes = 0
  for (const rel of rels) {
    const info = await stat(join(packageDir, rel))
    files.push({ path: rel, bytes: info.size })
    totalBytes += info.size
  }
  const integrity = await computePackageIntegrity(packageDir)
  return {
    name: manifest.name,
    version: manifest.version,
    integrity,
    files,
    totalBytes,
    published: false,
  }
}

function withinRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
}

async function hasDefaultExport(source: string): Promise<boolean> {
  const js = stripTypeScriptTypes(source, { mode: 'strip' })
  await exportLexerReady
  const [, exports] = parse(js)
  return exports.some((entry) => entry.n === 'default')
}

/**
 * Validate the package's declared self-test entry without executing package
 * code. Missing entry -> skipped.
 */
async function runSelfTest(
  packageDir: string,
  manifest: WorkflowPackageManifest,
  enabled: boolean,
): Promise<SelfTestResult> {
  const selfTest = manifest.skelm.selfTest
  if (selfTest === undefined) return { status: 'skipped' }
  if (!enabled) return { status: 'skipped', entry: selfTest.entry }

  const abs = join(packageDir, selfTest.entry)
  if (!withinRoot(packageDir, abs)) {
    return {
      status: 'failed',
      entry: selfTest.entry,
      detail: 'self-test entry escapes package root',
    }
  }
  try {
    const info = await stat(abs)
    if (!info.isFile()) {
      return {
        status: 'failed',
        entry: selfTest.entry,
        detail: 'self-test entry must be a regular file',
      }
    }

    const source = await readFile(abs, 'utf8')
    if (source.trim().length === 0) {
      return {
        status: 'failed',
        entry: selfTest.entry,
        detail: 'self-test file is empty',
      }
    }

    if (!(await hasDefaultExport(source))) {
      return {
        status: 'failed',
        entry: selfTest.entry,
        detail: 'self-test module must declare a default export',
      }
    }

    return { status: 'passed', entry: selfTest.entry }
  } catch (err) {
    return {
      status: 'failed',
      entry: selfTest.entry,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

function allPassed(stages: PublishStages, secretFindings: readonly SecretFinding[]): boolean {
  return (
    stages.validateManifest === 'passed' &&
    stages.secretScan === 'passed' &&
    stages.selfTest !== 'failed' &&
    stages.dryRun !== 'failed' &&
    secretFindings.length === 0
  )
}

/**
 * Run the full publish pipeline against a target workflow-package directory.
 * Returns a structured report. Never throws on a *package* problem (manifest
 * error, secret found, self-test failure) — those become `ok: false` with the
 * detail in the report; only genuinely unexpected I/O errors propagate.
 */
export async function runPublish(
  packageDir: string,
  options: PublishOptions = {},
): Promise<PublishReport> {
  const stages: PublishStages = {
    validateManifest: 'skipped',
    permissionSummary: 'skipped',
    secretScan: 'skipped',
    selfTest: 'skipped',
    dryRun: 'skipped',
  }
  const secretFindings: SecretFinding[] = []
  let selfTest: SelfTestResult = { status: 'skipped' }

  // Stage 1: validate manifest.
  let manifest: WorkflowPackageManifest
  const manifestPath = join(packageDir, PACKAGE_MANIFEST_FILENAME)
  try {
    const raw = await readFile(manifestPath, 'utf8')
    manifest = parsePackageManifest(raw, manifestPath)
    stages.validateManifest = 'passed'
  } catch (err) {
    stages.validateManifest = 'failed'
    const message =
      err instanceof PackageManifestError
        ? err.message
        : (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `no readable ${PACKAGE_MANIFEST_FILENAME} in ${packageDir}`
          : err instanceof Error
            ? err.message
            : String(err)
    return {
      ok: false,
      packageDir,
      stages,
      manifestError: message,
      secretFindings,
      selfTest,
    }
  }

  // Stage 2: permission summary (references only).
  const permissions = buildPermissionSummary(manifest)
  stages.permissionSummary = 'passed'

  // Stage 3: secret scan — a single hit fails the run.
  secretFindings.push(...(await scanPackageForSecrets(packageDir)))
  stages.secretScan = secretFindings.length === 0 ? 'passed' : 'failed'

  // Stage 4: self-test.
  selfTest = await runSelfTest(packageDir, manifest, options.runSelfTest !== false)
  stages.selfTest = selfTest.status

  // Stage 5: integrity + publish dry-run. Real publish is never performed.
  const dryRun = await buildDryRun(packageDir, manifest)
  stages.dryRun = 'passed'

  return {
    ok: allPassed(stages, secretFindings),
    packageDir,
    stages,
    name: manifest.name,
    version: manifest.version,
    permissions,
    secretFindings,
    selfTest,
    dryRun,
  }
}
