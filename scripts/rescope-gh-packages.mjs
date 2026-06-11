#!/usr/bin/env node
/**
 * Rescope every package's `name` field for GitHub Packages publication.
 *
 *   @skelm/<x>  ->  @scottgl9/<x>
 *   skelm       ->  @scottgl9/skelm
 *
 * Internal dependency keys are rewritten too, so GitHub-only versions install
 * from the same `@scottgl9` package channel instead of falling back to npmjs.
 *
 * Also points `publishConfig.registry` at https://npm.pkg.github.com so the
 * default `npm publish` lands in the right registry without a CLI flag.
 *
 * Usage:
 *   scripts/rescope-gh-packages.mjs apply     # rewrite + write `.gh-backup`
 *   scripts/rescope-gh-packages.mjs restore   # undo from `.gh-backup`
 *   scripts/rescope-gh-packages.mjs check     # exit non-zero if any package
 *                                              still uses `@skelm/*`
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PACKAGES_DIR = join(ROOT, 'packages')

const RENAME = {
  '@skelm/core': '@scottgl9/core',
  '@skelm/cli': '@scottgl9/cli',
  '@skelm/gateway': '@scottgl9/gateway',
  '@skelm/scheduler': '@scottgl9/scheduler',
  '@skelm/integrations': '@scottgl9/integrations',
  '@skelm/integration-sdk': '@scottgl9/integration-sdk',
  '@skelm/agentmemory': '@scottgl9/agentmemory',
  '@skelm/metrics': '@scottgl9/metrics',
  '@skelm/opencode': '@scottgl9/opencode',
  '@skelm/codex': '@scottgl9/codex',
  '@skelm/otel': '@scottgl9/otel',
  '@skelm/pi': '@scottgl9/pi',
  '@skelm/vercel-ai': '@scottgl9/vercel-ai',
  '@skelm/agent': '@scottgl9/agent',
  skelm: '@scottgl9/skelm',
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

function listPackageDirs() {
  return readdirSync(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'package.json')))
}

function apply() {
  for (const dir of listPackageDirs()) {
    const file = join(dir, 'package.json')
    const original = readFileSync(file, 'utf8')
    const pkg = JSON.parse(original)
    if (!RENAME[pkg.name]) continue
    writeFileSync(`${file}.gh-backup`, original)
    pkg.name = RENAME[pkg.name]
    rewriteDependencyMaps(pkg)
    pkg.publishConfig = { registry: 'https://npm.pkg.github.com', access: 'public' }
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
    console.log(`  ${dir}: -> ${pkg.name}`)
  }
}

function rewriteDependencyMaps(pkg) {
  for (const field of DEP_FIELDS) {
    const deps = pkg[field]
    if (deps === undefined) continue
    const rewritten = {}
    for (const [name, range] of Object.entries(deps)) {
      rewritten[RENAME[name] ?? name] = range
    }
    pkg[field] = rewritten
  }
}

function restore() {
  for (const dir of listPackageDirs()) {
    const backup = join(dir, 'package.json.gh-backup')
    if (!existsSync(backup)) continue
    writeFileSync(join(dir, 'package.json'), readFileSync(backup, 'utf8'))
    unlinkSync(backup)
    console.log(`  restored ${dir}/package.json`)
  }
}

function check() {
  const offenders = []
  for (const dir of listPackageDirs()) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (RENAME[pkg.name]) offenders.push(`${dir}: still ${pkg.name}`)
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (RENAME[name]) offenders.push(`${dir}: ${field} still references ${name}`)
      }
    }
  }
  if (offenders.length > 0) {
    console.error('rescope incomplete:')
    for (const line of offenders) console.error(`  ${line}`)
    process.exit(1)
  }
  console.log('rescope OK')
}

const cmd = process.argv[2]
switch (cmd) {
  case 'apply':
    apply()
    break
  case 'restore':
    restore()
    break
  case 'check':
    check()
    break
  default:
    console.error('usage: rescope-gh-packages.mjs (apply|restore|check)')
    process.exit(2)
}
