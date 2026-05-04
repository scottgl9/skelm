import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Tiny glob walker — supports `**` and `*` in the pattern. Skips
 * `node_modules`, `dist`, `coverage`, `.git`, `.skelm` directories. Returns
 * absolute paths.
 *
 * We deliberately avoid a heavy glob dep since the registry only uses it
 * for two well-known patterns. If needs grow, swap to `fast-glob`.
 */
export async function walkGlob(rootDir: string, pattern: string): Promise<string[]> {
  const matcher = compilePattern(pattern)
  const out: string[] = []
  await walk(rootDir, rootDir, matcher, out)
  out.sort()
  return out
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.skelm', '.next'])

async function walk(rootDir: string, dir: string, matcher: RegExp, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(rootDir, join(dir, entry.name), matcher, out)
    } else if (entry.isFile()) {
      const abs = join(dir, entry.name)
      const rel = relative(rootDir, abs).replace(/\\/g, '/')
      if (matcher.test(rel)) out.push(abs)
    }
  }
}

function compilePattern(pattern: string): RegExp {
  let re = '^'
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      // ** matches any depth, including zero segments
      re += '.*'
      i += 2
      if (pattern[i] === '/') i++
    } else if (c === '*') {
      re += '[^/]*'
      i++
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if (c !== undefined && /[.+^${}()|\[\]\\]/.test(c)) {
      re += `\\${c}`
      i++
    } else {
      re += c
      i++
    }
  }
  re += '$'
  return new RegExp(re)
}
