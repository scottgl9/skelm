#!/usr/bin/env tsx
// Guard: each package's public exports (top-level src/index.ts) match its
// committed baseline. New exports — i.e. widening the public surface —
// must be acknowledged by updating the baseline in the same commit.
//
// Modes:
//   pnpm exec tsx scripts/guards/public-export-baseline.ts            # check
//   pnpm exec tsx scripts/guards/public-export-baseline.ts --update   # write baselines
//
// The baseline format is intentionally trivial: one identifier per line,
// alphabetically sorted, including a "type:" or "value:" prefix so that
// promotions across the type/value boundary are visible. The parser is
// regex-based on `export {...}` and `export type {...}` blocks — it does
// not handle re-exports across packages perfectly, but it covers the
// common shapes used in this repo.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const BASELINE_DIR = join(__dirname, 'baselines')

interface PackageExports {
  pkg: string
  values: Set<string>
  types: Set<string>
}

const RE_EXPORT_BLOCK = /export\s+(type\s+)?\{([^}]+)\}/g
const RE_EXPORT_DECL =
  /^\s*export\s+(?:declare\s+)?(?:async\s+)?(class|function|const|let|var|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm

async function listPackages(): Promise<string[]> {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

async function packageExports(pkg: string): Promise<PackageExports | null> {
  const indexPath = join(PACKAGES_DIR, pkg, 'src', 'index.ts')
  let src: string
  try {
    src = await readFile(indexPath, 'utf8')
  } catch {
    return null
  }

  const values = new Set<string>()
  const types = new Set<string>()

  for (const m of src.matchAll(RE_EXPORT_BLOCK)) {
    const isType = m[1] !== undefined
    const list = m[2] ?? ''
    for (const item of list.split(',')) {
      const trimmed = item.trim()
      if (!trimmed) continue
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed)
      const name = asMatch ? asMatch[2] : trimmed.replace(/^type\s+/, '')
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue
      if (isType || /^type\s+/.test(trimmed)) types.add(name)
      else values.add(name)
    }
  }

  for (const m of src.matchAll(RE_EXPORT_DECL)) {
    const kind = m[1]
    const name = m[2]
    if (!name) continue
    if (kind === 'type' || kind === 'interface') types.add(name)
    else values.add(name)
  }

  return { pkg, values, types }
}

function format(p: PackageExports): string {
  const lines: string[] = []
  for (const v of [...p.values].sort()) lines.push(`value:${v}`)
  for (const t of [...p.types].sort()) lines.push(`type:${t}`)
  return `${lines.join('\n')}\n`
}

async function checkPackage(p: PackageExports, update: boolean): Promise<string[]> {
  const baselinePath = join(BASELINE_DIR, `${p.pkg}.txt`)
  const current = format(p)
  if (update) {
    await mkdir(BASELINE_DIR, { recursive: true })
    await writeFile(baselinePath, current)
    return []
  }
  let baseline: string
  try {
    baseline = await readFile(baselinePath, 'utf8')
  } catch {
    return [
      `${p.pkg}: no baseline at ${baselinePath.replace(`${REPO_ROOT}/`, '')}; run with --update to create`,
    ]
  }
  if (baseline === current) return []
  return diffLines(p.pkg, baseline, current)
}

function diffLines(pkg: string, baseline: string, current: string): string[] {
  const baseSet = new Set(baseline.trim().split('\n').filter(Boolean))
  const currSet = new Set(current.trim().split('\n').filter(Boolean))
  const added = [...currSet].filter((x) => !baseSet.has(x))
  const removed = [...baseSet].filter((x) => !currSet.has(x))
  const out: string[] = []
  for (const a of added) out.push(`${pkg}: +${a}`)
  for (const r of removed) out.push(`${pkg}: -${r}`)
  return out
}

async function main(): Promise<void> {
  const update = process.argv.includes('--update')
  const pkgs = await listPackages()
  const results: string[] = []
  let checked = 0
  for (const pkg of pkgs) {
    const ex = await packageExports(pkg)
    if (ex === null) continue
    checked++
    const diff = await checkPackage(ex, update)
    results.push(...diff)
  }
  if (results.length > 0) {
    process.stderr.write(`public-export-baseline: ${results.length} difference(s) from baseline:\n`)
    for (const line of results) process.stderr.write(`  ${line}\n`)
    process.stderr.write(
      `\n  if intended, run: pnpm exec tsx ${basename(fileURLToPath(import.meta.url))} --update\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`public-export-baseline: ok (${checked} packages checked)\n`)
}

await main()
