import { opendir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isAbsolute as isPosixAbsolute, normalize as normalizePosix } from 'node:path/posix'

import { AssetPathError } from './errors.js'

export interface AssetHost {
  getText(path: string): Promise<string>
  getJson<T = unknown>(path: string): Promise<T>
  getBytes(path: string): Promise<Uint8Array>
  exists(path: string): Promise<boolean>
  list(prefix?: string): Promise<string[]>
}

export function createAssetHost(root: string): AssetHost {
  const getRootRealPath = async (): Promise<string> => {
    try {
      return await realpath(root)
    } catch (err) {
      throw new AssetPathError(`workflow asset root is not accessible: ${root}`, err)
    }
  }

  const resolveAsset = async (path: string): Promise<string> => {
    const rootReal = await getRootRealPath()
    const assetPath = normalizeAssetPath(path)
    const resolved = resolve(rootReal, assetPath)
    let resolvedReal: string
    try {
      resolvedReal = await realpath(resolved)
    } catch (err) {
      if (isNotFoundError(err)) throw new AssetPathError(`asset not found: ${path}`)
      throw err
    }
    assertContained(rootReal, resolvedReal, path)
    return resolvedReal
  }

  return Object.freeze({
    async getText(path: string) {
      return await readFile(await resolveAsset(path), 'utf8')
    },
    async getJson<T = unknown>(path: string): Promise<T> {
      return JSON.parse(await readFile(await resolveAsset(path), 'utf8')) as T
    },
    async getBytes(path: string) {
      return new Uint8Array(await readFile(await resolveAsset(path)))
    },
    async exists(path: string) {
      try {
        await resolveAsset(path)
        return true
      } catch (err) {
        if (err instanceof AssetPathError || isNotFoundError(err)) return false
        throw err
      }
    },
    async list(prefix = '') {
      const rootReal = await getRootRealPath()
      const assetPrefix = normalizeAssetPath(prefix, { allowEmpty: true })
      const start = assetPrefix.length === 0 ? rootReal : resolve(rootReal, assetPrefix)
      let startReal: string
      try {
        startReal = await realpath(start)
      } catch (err) {
        if (isNotFoundError(err)) return []
        throw err
      }
      assertContained(rootReal, startReal, prefix)
      const out: string[] = []
      try {
        await collectAssets(rootReal, startReal, out)
      } catch (err) {
        if (isNotDirectoryError(err)) return [toAssetPath(rootReal, startReal)]
        throw err
      }
      return out.sort()
    },
  })
}

function normalizeAssetPath(path: string, opts: { allowEmpty?: boolean } = {}): string {
  if (path.includes('\0')) throw new AssetPathError('asset path must not contain NUL bytes')
  if (path.includes('\\')) throw new AssetPathError('asset paths must use forward slashes')
  if (isAbsolute(path) || isPosixAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw new AssetPathError('asset path must be relative')
  }
  const normalized = normalizePosix(path)
  if (normalized === '.') {
    if (opts.allowEmpty) return ''
    throw new AssetPathError('asset path must not be empty')
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new AssetPathError('asset path must stay inside the workflow asset root')
  }
  return normalized
}

function assertContained(rootReal: string, candidateReal: string, originalPath: string): void {
  const rel = relative(rootReal, candidateReal)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new AssetPathError(`asset path escapes workflow asset root: ${originalPath}`)
}

async function collectAssets(rootReal: string, dir: string, out: string[]): Promise<void> {
  const entries = await opendir(dir)
  for await (const entry of entries) {
    const path = resolve(dir, entry.name)
    let real: string
    try {
      real = await realpath(path)
      assertContained(rootReal, real, toAssetPath(rootReal, path))
    } catch (err) {
      if (err instanceof AssetPathError || isNotFoundError(err)) continue
      throw err
    }
    const entryStat = await stat(real)
    if (entryStat.isDirectory()) {
      // Skip traversing symlinked directories so list remains non-recursive through links.
      if (entry.isSymbolicLink()) continue
      await collectAssets(rootReal, real, out)
    } else if (entryStat.isFile()) {
      out.push(toAssetPath(rootReal, real))
    }
  }
}

function toAssetPath(rootReal: string, path: string): string {
  return relative(rootReal, path).split(sep).join('/')
}

function isNotFoundError(err: unknown): boolean {
  return isSystemErrorCode(err, 'ENOENT')
}

function isNotDirectoryError(err: unknown): boolean {
  return isSystemErrorCode(err, 'ENOTDIR')
}

function isSystemErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  )
}
