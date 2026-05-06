#!/usr/bin/env tsx
/**
 * Guard: every PR that changes published-package source must include a
 * changeset (or explicitly opt out).
 *
 * Run from CI with the merge-base passed in via env or argv:
 *   pnpm exec tsx scripts/guards/changelog-present.ts --base origin/main
 *
 * Outside CI, the guard is a no-op when run from a clean tree against the
 * current branch tip — there's nothing to compare against.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')

interface Args {
  base: string
  skipMarker: string
}

function parseArgs(argv: readonly string[]): Args {
  let base = process.env.SKELM_BASE_REF ?? 'origin/main'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) {
      base = argv[i + 1] as string
      i++
    }
  }
  return { base, skipMarker: '[skip changeset]' }
}

function changedFiles(base: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${base}...HEAD`, {
      cwd: ROOT,
      encoding: 'utf8',
    })
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function privatePackages(): Set<string> {
  const out = new Set<string>()
  const pkgRoot = join(ROOT, 'packages')
  if (!existsSync(pkgRoot)) return out
  for (const name of readdirSync(pkgRoot)) {
    const pj = join(pkgRoot, name, 'package.json')
    if (!existsSync(pj)) continue
    try {
      const json = JSON.parse(readFileSync(pj, 'utf8')) as { private?: boolean }
      if (json.private) out.add(name)
    } catch {
      // ignore unreadable package.json
    }
  }
  return out
}

function touchesPublishedSource(files: readonly string[]): string | null {
  const skip = privatePackages()
  for (const f of files) {
    const m = f.match(/^packages\/([^/]+)\/src\//)
    if (!m) continue
    const pkg = m[1] as string
    if (skip.has(pkg)) continue
    return f
  }
  return null
}

function hasChangeset(files: readonly string[]): boolean {
  return files.some((f) => /^\.changeset\/[^/]+\.md$/.test(f) && !f.endsWith('README.md'))
}

function prDescriptionHasSkipMarker(marker: string): boolean {
  const desc = process.env.SKELM_PR_BODY ?? ''
  return desc.includes(marker)
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const files = changedFiles(args.base)
  if (files.length === 0) {
    process.stderr.write('changelog-present: no diff against base; skipping\n')
    return 0
  }
  const offender = touchesPublishedSource(files)
  if (offender === null) {
    return 0
  }
  if (hasChangeset(files)) {
    return 0
  }
  if (prDescriptionHasSkipMarker(args.skipMarker)) {
    process.stderr.write(`changelog-present: PR body contains "${args.skipMarker}"; allowed\n`)
    return 0
  }
  process.stderr.write(
    [
      'changelog-present: published-package source changed without a changeset.',
      `  example: ${offender}`,
      '  Run `pnpm changeset` to add one, or include the marker',
      `  "${args.skipMarker}" in the PR description for trivial / docs-only changes.`,
      '',
    ].join('\n'),
  )
  return 1
}

process.exit(main())
