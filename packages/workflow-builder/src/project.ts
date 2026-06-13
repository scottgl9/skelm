// Filesystem-backed ProjectSource. Every read is bounded to the project root:
// the builder is fsRead-scoped to the project, and this is the structural
// enforcement of that scope. The builder never writes through here — writes go
// exclusively through the gateway apply route.

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ConfigError } from '@skelm/core'
import type { ProjectSource } from './types.js'

const WORKFLOW_FILE_RE = /\.workflow\.(mts|ts)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '.skelm', '.git'])

/**
 * Throws when `candidate` resolves outside `root`. Uses lexical resolution so
 * the check holds for paths that do not yet exist (e.g. a proposed new
 * workflow file). Callers that read existing files additionally realpath to
 * defeat symlink escapes.
 */
export function assertInsideProject(root: string, candidate: string): string {
  const absRoot = resolve(root)
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(absRoot, candidate)
  const rel = relative(absRoot, abs)
  if (rel === '' || rel === '.') return abs
  if (rel.startsWith('..') || rel.split(sep).includes('..') || isAbsolute(rel)) {
    throw new ConfigError(`path escapes the project root: ${candidate}`)
  }
  return abs
}

export function createProjectSource(root: string): ProjectSource {
  const absRoot = resolve(root)
  return {
    root: absRoot,
    async listWorkflowFiles() {
      const out: string[] = []
      await walk(absRoot, out)
      out.sort()
      return out
    },
    async readFile(path) {
      const abs = assertInsideProject(absRoot, path)
      // Defeat symlink escapes: the realpath of the file must still be inside
      // the project root. A missing file realpath()s its existing parent, so a
      // not-found read surfaces as ENOENT rather than a scope error.
      const real = await realpath(abs).catch(() => abs)
      assertInsideProject(absRoot, real)
      return readFile(abs, 'utf8')
    },
  }
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(join(dir, entry.name), out)
    } else if (entry.isFile() && WORKFLOW_FILE_RE.test(entry.name)) {
      const full = join(dir, entry.name)
      const info = await stat(full).catch(() => undefined)
      if (info?.isFile()) out.push(full)
    }
  }
}
