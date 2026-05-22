// Shared loader for `.ts` / `.mts` / `.js` modules referenced from pipeline
// files.
//
// Uses Node's native dynamic import(), which on Node 22.18+ ships unflagged
// stable TypeScript type stripping for `.ts` / `.mts` files. The CLI's
// workflow loader and `code()` steps that use `module:` both route through
// this helper so behavior stays consistent — including the require(esm)
// double-default unwrap that Node 22+ produces for CJS-interop modules.

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface LoadTsModuleOptions {
  /**
   * Directory used to resolve a relative `path`. Defaults to
   * `process.cwd()`. Ignored when `path` is absolute or a `file://` URL.
   */
  readonly baseDir?: string
}

const moduleCache = new Map<string, Promise<Record<string, unknown>>>()

/**
 * Load a `.ts` / `.js` module by path or `file://` URL and return its
 * namespace object. Repeat calls for the same absolute URL are deduplicated.
 *
 * **Caching:** the loader memoizes resolved modules in a process-global
 * `Map` keyed by absolute `file://` URL. The entry lives for the lifetime
 * of the process — there is no TTL, no file-mtime check, and no eviction.
 * If a module file changes on disk after first load (e.g. a deployment that
 * swaps a step file under a long-running gateway), the stale module keeps
 * being served until restart. Tests can call `clearTsModuleCache()` to
 * force a fresh import.
 *
 * The returned object is the raw namespace from `import()`; callers that
 * need a specific export should reach for `pickExport()`.
 */
export function loadTsModule(
  path: string | URL,
  opts: LoadTsModuleOptions = {},
): Promise<Record<string, unknown>> {
  let url: string
  try {
    url = toFileUrl(path, opts.baseDir)
  } catch (err) {
    return Promise.reject(err)
  }
  let inflight = moduleCache.get(url)
  if (inflight === undefined) {
    inflight = import(url) as Promise<Record<string, unknown>>
    moduleCache.set(url, inflight)
  }
  return inflight
}

/**
 * Pick a named export from a module loaded by `loadTsModule`. When
 * `exportName` is `'default'`, transparently unwraps the require(esm) shape
 * (`{ default: { default: <value> } }`) that Node 22+'s CJS interop produces
 * when loading an ESM module from a CJS host.
 */
export function pickExport(mod: Record<string, unknown>, exportName: string): unknown {
  if (exportName !== 'default') return mod[exportName]
  const direct = mod.default
  if (direct === undefined || direct === null) return direct
  if (typeof direct === 'object') {
    const inner = (direct as Record<string, unknown>).default
    if (inner !== undefined) return inner
  }
  return direct
}

/** For tests: clear the loader cache so a fresh import is forced. */
export function clearTsModuleCache(): void {
  moduleCache.clear()
}

function toFileUrl(path: string | URL, baseDir: string | undefined): string {
  if (path instanceof URL) return path.href
  if (path.startsWith('file://')) return path
  const absolute = isAbsolute(path) ? path : resolve(baseDir ?? process.cwd(), path)
  if (!existsSync(absolute)) {
    throw new Error(`ts-loader: module not found: ${absolute}`)
  }
  return pathToFileURL(absolute).href
}
