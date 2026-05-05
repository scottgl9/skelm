#!/usr/bin/env node
/**
 * Rewrite `workspace:*` (and `workspace:^`, `workspace:~`, `workspace:<range>`)
 * dependency specifiers in each package.json to a concrete semver range so
 * `npm publish` produces a tarball that consumers can install. `pnpm publish`
 * does this automatically inside the tarball; this script does it explicitly
 * on disk so the behavior is the same regardless of which publish CLI runs.
 *
 * Usage:
 *   scripts/rewrite-workspace-deps.mjs rewrite       # rewrite all packages, write a backup
 *   scripts/rewrite-workspace-deps.mjs restore       # restore from backup
 *   scripts/rewrite-workspace-deps.mjs check         # exit non-zero if any workspace:* remains
 *
 * Backups live at packages/<name>/package.json.backup and are restored after publish.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PACKAGES_DIR = join(ROOT, 'packages')

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

function listPackages() {
  return readdirSync(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'package.json')))
}

function readPkg(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writePkg(file, pkg) {
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
}

function buildVersionMap(packages) {
  const map = new Map()
  for (const dir of packages) {
    const pkg = readPkg(join(dir, 'package.json'))
    if (pkg.name && pkg.version) map.set(pkg.name, pkg.version)
  }
  return map
}

function rewriteSpec(spec, depName, versions) {
  if (typeof spec !== 'string' || !spec.startsWith('workspace:')) return spec
  const target = versions.get(depName)
  if (!target) {
    throw new Error(`workspace:* dependency ${depName} has no resolvable version in the workspace`)
  }
  // workspace:*       -> ^<version>
  // workspace:^       -> ^<version>
  // workspace:~       -> ~<version>
  // workspace:^1.2.3  -> ^1.2.3
  // workspace:1.2.3   -> 1.2.3
  const rest = spec.slice('workspace:'.length)
  if (rest === '*' || rest === '') return `^${target}`
  if (rest === '^') return `^${target}`
  if (rest === '~') return `~${target}`
  return rest // already a real range
}

function rewrite() {
  const packages = listPackages()
  const versions = buildVersionMap(packages)
  let changedCount = 0
  for (const dir of packages) {
    const file = join(dir, 'package.json')
    const original = readFileSync(file, 'utf8')
    const pkg = JSON.parse(original)
    let dirty = false
    for (const field of DEP_FIELDS) {
      const deps = pkg[field]
      if (!deps) continue
      for (const [k, v] of Object.entries(deps)) {
        const rewritten = rewriteSpec(v, k, versions)
        if (rewritten !== v) {
          deps[k] = rewritten
          dirty = true
          console.log(`  ${pkg.name}: ${field}.${k}  ${v}  ->  ${rewritten}`)
        }
      }
    }
    if (dirty) {
      writeFileSync(file + '.backup', original)
      writePkg(file, pkg)
      changedCount += 1
    }
  }
  console.log(`rewrote ${changedCount} package.json file(s)`)
}

function restore() {
  const packages = listPackages()
  let restoredCount = 0
  for (const dir of packages) {
    const backup = join(dir, 'package.json.backup')
    if (!existsSync(backup)) continue
    const original = readFileSync(backup, 'utf8')
    writeFileSync(join(dir, 'package.json'), original)
    unlinkSync(backup)
    restoredCount += 1
    console.log(`  restored ${dir}/package.json`)
  }
  console.log(`restored ${restoredCount} package.json file(s)`)
}

function check() {
  const packages = listPackages()
  const offenders = []
  for (const dir of packages) {
    const pkg = readPkg(join(dir, 'package.json'))
    for (const field of DEP_FIELDS) {
      const deps = pkg[field]
      if (!deps) continue
      for (const [k, v] of Object.entries(deps)) {
        if (typeof v === 'string' && v.startsWith('workspace:')) {
          offenders.push(`${pkg.name}: ${field}.${k} = ${v}`)
        }
      }
    }
  }
  if (offenders.length > 0) {
    console.error('workspace:* dependencies still present:')
    for (const line of offenders) console.error('  ' + line)
    process.exit(1)
  }
  console.log('no workspace:* dependencies found')
}

const cmd = process.argv[2]
switch (cmd) {
  case 'rewrite':
    rewrite()
    break
  case 'restore':
    restore()
    break
  case 'check':
    check()
    break
  default:
    console.error('usage: rewrite-workspace-deps.mjs (rewrite|restore|check)')
    process.exit(2)
}
