#!/usr/bin/env tsx
/**
 * dist-invariants — fail fast if any published package's `dist/` is missing
 * a feature its source advertises (stale build / forgotten rebuild).
 *
 * Reads MANIFEST below: each entry pairs a source proof with a substring
 * the built dist must contain. Skips entries whose source has been removed
 * (so legitimate rollbacks don't misfire). Wired into `pnpm guards` and
 * each publishable package's `prepublishOnly`.
 *
 * To add an invariant: append a small, specific needle (a unique function
 * name, not boilerplate). Keep the list short — this is a publish smoke
 * test, not a coverage suite.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Invariant {
  /** Human-readable name for the feature (printed in failures). */
  feature: string
  /** The package whose dist we inspect (under `packages/`). */
  pkg: string
  /** Path to the dist file, relative to the package root. */
  distFile: string
  /** Substring that MUST appear in the dist file. */
  needle: string
  /**
   * Source files (relative to the package root) that prove the feature is
   * supposed to ship. If NONE of these exist or contain the source needle,
   * the invariant is skipped — i.e. the source was rolled back legitimately.
   */
  sourceProof: { file: string; needle: string }[]
  /** Optional issue / commit reference used when this invariant was added. */
  origin?: string
}

const MANIFEST: Invariant[] = [
  {
    feature: 'code({ module }) + ctx.exec helper (0dd4822)',
    pkg: 'core',
    distFile: 'dist/execution/handlers.js',
    needle: 'resolveCodeRun',
    sourceProof: [{ file: 'src/execution/handlers.ts', needle: 'resolveCodeRun' }],
    origin: 'F038 / issue #136 — v0.4.1 published with a stale handlers.js',
  },
  {
    feature: 'skelm init merges over npm-init dirs (e2ee59d, F036 follow-up)',
    pkg: 'cli',
    distFile: 'dist/init.js',
    needle: 'isMergeableNpmInitDir',
    sourceProof: [{ file: 'src/init.ts', needle: 'isMergeableNpmInitDir' }],
    origin: 'F036 / issue #135',
  },
  {
    feature: 'gateway start releases lockfile on EADDRINUSE (F042)',
    pkg: 'gateway',
    distFile: 'dist/lifecycle/gateway.js',
    needle: 'releaseLockfile',
    sourceProof: [{ file: 'src/lifecycle/gateway.ts', needle: 'releaseLockfile' }],
    origin: 'F042 / issue #140',
  },
  {
    feature: 'gateway HTTP listener reflects listen errors (F042)',
    pkg: 'gateway',
    distFile: 'dist/http/server.js',
    // The error listener uses `.once('error', …)` against the http.Server.
    // We look for that callback chain rather than a free-form comment so
    // the check survives doc reflows.
    needle: "once('error'",
    sourceProof: [{ file: 'src/http/server.ts', needle: "once('error'" }],
    origin: 'F042 / issue #140',
  },
]

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

interface Failure {
  feature: string
  reason: string
  detail?: string
}

const failures: Failure[] = []

for (const inv of MANIFEST) {
  const pkgRoot = resolve(REPO, 'packages', inv.pkg)
  // Skip the invariant when none of its source proof files exist — the
  // feature has been removed legitimately and the guard would otherwise
  // misfire.
  const sourcePresent = inv.sourceProof.some((p) => {
    const path = resolve(pkgRoot, p.file)
    if (!existsSync(path)) return false
    const content = readFileSync(path, 'utf8')
    return content.includes(p.needle)
  })
  if (!sourcePresent) continue

  const distPath = resolve(pkgRoot, inv.distFile)
  if (!existsSync(distPath)) {
    failures.push({
      feature: inv.feature,
      reason: `dist file missing: packages/${inv.pkg}/${inv.distFile}`,
      detail: 'Run `pnpm build` before publishing or running `pnpm check`.',
    })
    continue
  }
  const dist = readFileSync(distPath, 'utf8')
  if (!dist.includes(inv.needle)) {
    failures.push({
      feature: inv.feature,
      reason: `dist file packages/${inv.pkg}/${inv.distFile} is missing required substring \`${inv.needle}\``,
      detail: `Source proof exists in packages/${inv.pkg}/${inv.sourceProof[0]?.file}. The dist tarball is stale — rebuild before publishing.${
        inv.origin !== undefined ? `\n         Origin: ${inv.origin}` : ''
      }`,
    })
  }
}

if (failures.length === 0) {
  process.stdout.write(`dist-invariants: OK (${MANIFEST.length} invariants checked)\n`)
  process.exit(0)
}

process.stderr.write('dist-invariants: FAIL\n')
for (const f of failures) {
  process.stderr.write(`\n  ✗ ${f.feature}\n`)
  process.stderr.write(`      ${f.reason}\n`)
  if (f.detail !== undefined) {
    process.stderr.write(`      hint: ${f.detail}\n`)
  }
}
process.stderr.write('\n')
process.exit(1)
