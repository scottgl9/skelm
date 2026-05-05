#!/usr/bin/env node
/**
 * Rescope every package's `name` field for GitHub Packages publication.
 *
 *   @skelm/<x>  ->  @scottgl9/<x>
 *   skelm       ->  @scottgl9/skelm
 *
 * Internal `dependencies` keep their `@skelm/*` names — they install
 * anonymously from npmjs.org so consumers only need a GitHub Packages
 * token for the `@scottgl9` scope, not for transitive deps.
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

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
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
  '@skelm/metrics': '@scottgl9/metrics',
  '@skelm/opencode': '@scottgl9/opencode',
  '@skelm/otel': '@scottgl9/otel',
  '@skelm/pi': '@scottgl9/pi',
  skelm: '@scottgl9/skelm',
}

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
    writeFileSync(file + '.gh-backup', original)
    pkg.name = RENAME[pkg.name]
    pkg.publishConfig = { registry: 'https://npm.pkg.github.com', access: 'public' }
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
    console.log(`  ${dir}: -> ${pkg.name}`)
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
  }
  if (offenders.length > 0) {
    console.error('rescope incomplete:')
    for (const line of offenders) console.error('  ' + line)
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
