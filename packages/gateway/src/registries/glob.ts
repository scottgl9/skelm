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
  // Bound the walk to the static prefix of the pattern. For
  // `workflows/**/*.workflow.ts` we scan `${rootDir}/workflows`, not
  // the entire `${rootDir}` subtree. This keeps `gateway start` cheap
  // when projectRoot defaults to cwd ($HOME under systemd-user), where
  // a naive recursive walk would chew through gigabytes of unrelated
  // files before timing out.
  const staticPrefix = extractStaticPrefix(pattern)
  const scanRoot = staticPrefix === '' ? rootDir : join(rootDir, staticPrefix)
  await walk(rootDir, scanRoot, matcher, out)
  out.sort()
  return out
}

/**
 * Returns the leading path segment(s) of `pattern` that contain no glob
 * metacharacters. For `workflows/**\/*.workflow.ts` this is `workflows`;
 * for `**\/foo.ts` it is `''`.
 */
function extractStaticPrefix(pattern: string): string {
  const segments = pattern.split('/')
  const staticSegments: string[] = []
  for (const seg of segments) {
    if (/[*?\[\]{}]/.test(seg)) break
    staticSegments.push(seg)
  }
  // Pop the last segment if it looks like a filename (only relevant when
  // the entire pattern is literal — degenerate case we don't bother with).
  return staticSegments.join('/')
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
