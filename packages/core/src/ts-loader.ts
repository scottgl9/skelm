// Shared loader for `.ts` / `.js` modules referenced from pipeline files.
//
// Built on tsx's programmatic API so customers can author helper modules in
// TypeScript without a build step. The CLI's workflow loader and `code()`
// steps that use `module:` both route through this helper so behavior stays
// consistent — including the require(esm) double-default unwrap that Node
// 22+ produces under tsx's CJS path.

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'

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
 * The returned object is the raw namespace as resolved by tsx; callers that
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
    inflight = tsImport(url, import.meta.url) as Promise<Record<string, unknown>>
    moduleCache.set(url, inflight)
  }
  return inflight
}

/**
 * Pick a named export from a module loaded by `loadTsModule`. When
 * `exportName` is `'default'`, transparently unwraps the require(esm) shape
 * (`{ default: { default: <value> } }`) that Node 22+'s CJS interop produces
 * for ESM modules.
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

/** Resolve a `file://` URL to an absolute filesystem path. */
export function fileUrlToPath(url: string): string {
  return fileURLToPath(url)
}
