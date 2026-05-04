#!/usr/bin/env tsx
// Guard: every field on AgentPermissions has at least one mention in
// packages/core/test/security/. The convention is that a fixture file
// references the field name (e.g. `allowedTools`, `networkEgress`) when it
// asserts the deny path for that dimension. A new field on the interface
// without a corresponding fixture is a security regression.
//
// This is a structural sanity check, not semantic verification. It cannot
// catch a fixture that mentions the field but tests the wrong thing — that
// is what code review is for. What it does catch is silent additions.

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

const PERMISSIONS_FILE = join(REPO_ROOT, 'packages/core/src/permissions.ts')
const SECURITY_DIR = join(REPO_ROOT, 'packages/core/test/security')

// Fields that exist on AgentPermissions but are intentionally not exercised
// as a deny dimension on their own. Add a justification when extending.
const EXEMPT_FIELDS = new Set<string>([
  'profile', // not a permission dimension; selects a named permission profile
  'approval', // gating policy, not an allow/deny dimension
])

async function readPermissionFields(): Promise<string[]> {
  const src = await readFile(PERMISSIONS_FILE, 'utf8')
  const start = src.indexOf('export interface AgentPermissions {')
  if (start === -1) {
    throw new Error(`could not find AgentPermissions interface in ${PERMISSIONS_FILE}`)
  }
  const end = src.indexOf('}', start)
  if (end === -1) {
    throw new Error(`could not find end of AgentPermissions interface in ${PERMISSIONS_FILE}`)
  }
  const block = src.slice(start, end)
  const fields: string[] = []
  for (const line of block.split('\n')) {
    const m = /^\s*(?:readonly\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\??:/.exec(line)
    if (m && m[1] !== undefined) fields.push(m[1])
  }
  return fields
}

async function readSecurityCorpus(): Promise<string> {
  const entries = await readdir(SECURITY_DIR, { withFileTypes: true })
  const parts: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    parts.push(await readFile(join(SECURITY_DIR, entry.name), 'utf8'))
  }
  return parts.join('\n')
}

async function main(): Promise<void> {
  const [fields, corpus] = await Promise.all([readPermissionFields(), readSecurityCorpus()])
  const missing: string[] = []
  for (const field of fields) {
    if (EXEMPT_FIELDS.has(field)) continue
    if (!corpus.includes(field)) missing.push(field)
  }
  if (missing.length > 0) {
    process.stderr.write(
      `default-deny-permissions: missing adversarial fixture coverage for ${missing.join(', ')}\n  declare a fixture under ${SECURITY_DIR.replace(`${REPO_ROOT}/`, '')} that\n  references each missing field, or add it to EXEMPT_FIELDS in this script\n  with a justification comment.\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`default-deny-permissions: ok (${fields.length} fields covered)\n`)
}

await main()
