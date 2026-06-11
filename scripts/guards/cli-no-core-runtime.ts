#!/usr/bin/env tsx
// Guard: packages/cli/src/** must NOT import the gateway-owned runtime
// primitives. Since the CLI-as-gateway-interface refactor the CLI is a
// thin client over the gateway HTTP surface; any reintroduction of an
// in-process Runner / EventBus / FileSecretResolver / etc. would re-
// duplicate logic the gateway is now the single source of truth for.
//
// Allowlist: packages/cli/src/gateway.ts may still import buildBackend-
// Registry because it bootstraps the gateway itself when run in
// --foreground mode. packages/cli/src/validate.ts and load-workflow.ts
// may load a workflow locally because validate is offline-exempt.

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_SRC = join(REPO_ROOT, 'packages/cli/src')

// Symbols that, if imported anywhere under packages/cli/src/**, mean the
// CLI is re-implementing gateway responsibilities in-process.
const FORBIDDEN = [
  'runPipeline',
  'Runner',
  'EventBus',
  'SqliteRunStore',
  'SkillRegistry',
  'ChainAuditWriter',
  'FileSecretResolver',
  'EnvSecretResolver',
  'WorkspaceManager',
] as const

// Files exempted from the rule, with a one-line justification each.
const ALLOWLIST = new Map<string, string>([
  ['gateway.ts', 'bootstraps the gateway itself when run in --foreground'],
  ['backends.ts', 'helper used by gateway.ts during foreground gateway start'],
  ['validate.ts', 'offline-exempt: validates workflow file structure'],
  ['load-workflow.ts', 'helper used by validate.ts'],
  ['load-config.ts', 'helper used by gateway.ts during foreground gateway start'],
])

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir)) {
    const p = join(dir, entry)
    const s = await stat(p)
    if (s.isDirectory()) yield* walk(p)
    else if (entry.endsWith('.ts')) yield p
  }
}

async function main(): Promise<void> {
  const violations: { file: string; symbol: string; line: number }[] = []
  for await (const file of walk(CLI_SRC)) {
    const rel = relative(CLI_SRC, file)
    if (ALLOWLIST.has(rel)) continue
    const src = await readFile(file, 'utf8')
    const importMatches = [...src.matchAll(/^(?:import|export).*?from\s+['"]([^'"]+)['"]/gm)]
    for (const m of importMatches) {
      const importStmt = m[0]
      const specifier = m[1] ?? ''
      const line = lineOf(src, m.index ?? 0)
      if (isDeepRuntimeSpecifier(specifier)) {
        violations.push({ file: rel, symbol: specifier, line })
      }
      for (const sym of FORBIDDEN) {
        // Match the symbol as a whole word inside the import braces.
        const re = new RegExp(`[{,\\s]${sym}[\\s,}]`)
        if (re.test(importStmt)) {
          violations.push({ file: rel, symbol: sym, line })
        }
      }
    }
    const dynamicMatches = [
      ...src.matchAll(/const\s*{([^}]+)}\s*=\s*await\s*import\(\s*['"]([^'"]+)['"]\s*\)/gms),
    ]
    for (const m of dynamicMatches) {
      const bindings = m[1] ?? ''
      const specifier = m[2] ?? ''
      if (!isRuntimePackage(specifier)) continue
      const line = lineOf(src, m.index ?? 0)
      if (isDeepRuntimeSpecifier(specifier)) {
        violations.push({ file: rel, symbol: specifier, line })
      }
      for (const sym of FORBIDDEN) {
        const re = new RegExp(`(?:^|[,\\s])${sym}(?:\\s|,|:|$)`)
        if (re.test(bindings)) violations.push({ file: rel, symbol: sym, line })
      }
    }
    const dynamicSpecifierMatches = [
      ...src.matchAll(/(?<!type\s+)import\(\s*['"]([^'"]+)['"]\s*\)/gm),
    ]
    for (const m of dynamicSpecifierMatches) {
      const specifier = m[1] ?? ''
      if (isDeepRuntimeSpecifier(specifier)) {
        violations.push({ file: rel, symbol: specifier, line: lineOf(src, m.index ?? 0) })
      }
    }
  }

  if (violations.length === 0) {
    process.stdout.write('cli-no-core-runtime: ok\n')
    return
  }
  process.stderr.write('cli-no-core-runtime: violations found\n')
  for (const v of violations) {
    process.stderr.write(`  packages/cli/src/${v.file}:${v.line} imports ${v.symbol}\n`)
  }
  process.stderr.write(
    '\nThe CLI is meant to dispatch to the gateway. Move runtime work\n  into the gateway and have the CLI call it over HTTP.\n  If a new exemption is genuinely warranted, add the file to ALLOWLIST\n  in scripts/guards/cli-no-core-runtime.ts with a one-line justification.\n',
  )
  process.exit(1)
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

function isRuntimePackage(specifier: string): boolean {
  return specifier === '@skelm/core' || specifier === '@skelm/gateway'
}

function isDeepRuntimeSpecifier(specifier: string): boolean {
  return specifier.startsWith('@skelm/core/') || specifier.startsWith('@skelm/gateway/')
}

void main().catch((err) => {
  process.stderr.write(`cli-no-core-runtime: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
