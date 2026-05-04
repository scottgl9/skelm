#!/usr/bin/env node
// gateway-only-enforcement.ts
//
// Ensures that use of `node:child_process` (and other gateway-tier OS
// primitives) outside the `packages/gateway/` directory is intentional and
// annotated. Any source file that imports child_process must either:
//   a) be in the explicit allowlist below, OR
//   b) carry an `// @subprocess-ok: <reason>` line comment near the import.
//
// The allowlist covers subsystems with designed, reviewed subprocess use:
//   - MCP stdio client    — spawns MCP server processes for tool calls
//   - ACP stdio client    — spawns ACP agents for agent steps
//   - Script trigger      — spawns user-defined trigger scripts (gateway-owned)
//   - Workspace manager   — runs git diff / workspace lifecycle commands
//   - pi backend          — inspects the Pi coding agent binary
//
// Adding a new non-gateway subprocess caller: add `// @subprocess-ok: <reason>`
// on the same line or the line immediately before the `node:child_process` import.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

// Explicit allowlist: relative paths from repo root.
// These are reviewed and understood; no annotation required.
const ALLOWLIST = new Set([
  'packages/core/src/mcp/client.ts',
  'packages/core/src/acp/client.ts',
  'packages/core/src/acp/backend.ts',
  'packages/core/src/triggers/script.ts',
  'packages/core/src/workspace.ts',
  'packages/pi/src/provider.ts',
  'packages/pi/src/backend.ts',
])

// Directories (relative to ROOT) whose child_process use is unrestricted.
const GATEWAY_DIRS = ['packages/gateway/']

const CHILD_PROCESS_RE = /['"]node:child_process['"]/
const SUBPROCESS_OK_RE = /\/\/ @subprocess-ok:/

function findSourceFiles(root: string): string[] {
  const result: string[] = []
  const SKIP = new Set(['node_modules', 'dist', '.git', 'test'])
  function walk(dir: string) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        result.push(full)
      }
    }
  }
  walk(join(root, 'packages'))
  return result
}

function check(): { violations: string[]; checked: number } {
  const files = findSourceFiles(ROOT)
  const violations: string[] = []
  let checked = 0

  for (const file of files) {
    const rel = relative(ROOT, file)

    // Gateway files are unrestricted.
    if (GATEWAY_DIRS.some((d) => rel.startsWith(d))) continue

    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!CHILD_PROCESS_RE.test(content)) continue

    checked++

    // In the allowlist — skip.
    if (ALLOWLIST.has(rel)) continue

    // Check for @subprocess-ok annotation anywhere in the file.
    if (SUBPROCESS_OK_RE.test(content)) continue

    violations.push(rel)
  }

  return { violations, checked }
}

const { violations, checked } = check()

if (violations.length > 0) {
  process.stderr.write(
    `gateway-only-enforcement: ${violations.length} violation(s) — files using node:child_process without allowlist entry or @subprocess-ok annotation:\n`,
  )
  for (const v of violations) {
    process.stderr.write(`  ${v}\n`)
  }
  process.stderr.write(
    '\nTo fix: add the file to the ALLOWLIST in scripts/guards/gateway-only-enforcement.ts,\n' +
      'or add a line comment: // @subprocess-ok: <reason>\n',
  )
  process.exit(1)
}

process.stdout.write(
  `gateway-only-enforcement: ok (${checked} child_process caller(s) verified across non-gateway packages)\n`,
)
