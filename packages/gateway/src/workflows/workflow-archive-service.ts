import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, posix, resolve, sep } from 'node:path'
import { type UnzipFileInfo, unzip } from 'fflate'
import { WorkflowRegistrationError } from './workflow-registration-service.js'

/**
 * File extensions an uploaded workflow archive is allowed to contain. The
 * gateway extracts the archive into a managed directory and the runtime
 * `import()`s the entry file from there, so the surface that ever touches
 * code is the loader — but defence-in-depth: anything that isn't a workflow
 * source, schema, or docs file is rejected at extraction time.
 */
const ALLOWED_EXTENSIONS = new Set<string>([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.yaml',
  '.yml',
])

const ZIP_MAGIC = Uint8Array.of(0x50, 0x4b, 0x03, 0x04)

export interface WorkflowArchiveOptions {
  /** Root under which per-id extraction directories live. */
  uploadRoot: string
  /** Max accepted .zip size, applied to both the archive and the sum of uncompressed entries. */
  maxBytes: number
}

export interface ExtractInput {
  id: string
  /** Raw .zip bytes. */
  archive: Uint8Array
  /** Optional relative entry path inside the archive (e.g. `foo.workflow.ts`). */
  entry?: string
  /** When 'register', refuse non-empty destination; when 'replace', atomically swap. */
  mode: 'register' | 'replace'
}

export interface ExtractResult {
  /** Absolute path to the extracted directory. */
  extractedDir: string
  /** Absolute path to the chosen entry workflow file. */
  entryPath: string
}

/**
 * Extracts uploaded workflow archives into a gateway-owned directory under
 * `${stateDir}/uploaded-workflows/${id}/`. The extracted entry path is then
 * fed back into the existing path-based registration flow so the trust
 * boundary stays in one place.
 */
export class WorkflowArchiveService {
  constructor(private readonly options: WorkflowArchiveOptions) {}

  get uploadRoot(): string {
    return this.options.uploadRoot
  }

  /** Returns the directory a given id's archive extracts to. */
  destinationFor(id: string): string {
    return join(this.options.uploadRoot, encodeURIComponent(id))
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    if (!(input.archive instanceof Uint8Array) || input.archive.byteLength === 0) {
      throw new WorkflowRegistrationError(400, 'archive is required')
    }
    if (input.archive.byteLength > this.options.maxBytes) {
      throw new WorkflowRegistrationError(
        413,
        `archive exceeds maximum size of ${this.options.maxBytes} bytes`,
      )
    }
    if (!hasZipMagic(input.archive)) {
      throw new WorkflowRegistrationError(400, 'uploaded file is not a .zip archive')
    }

    // Stop zip bombs before decompression: fflate's filter hook fires with each
    // entry's central-directory `originalSize`, so we can reject any entry whose
    // uncompressed size exceeds the cap before allocating its decoded bytes.
    // Run async so a CPU-bound decompress doesn't stall the gateway event loop.
    const maxBytes = this.options.maxBytes
    let entries: Record<string, Uint8Array>
    try {
      entries = await new Promise<Record<string, Uint8Array>>((resolveUnzip, rejectUnzip) => {
        unzip(
          input.archive,
          {
            filter(file: UnzipFileInfo) {
              if (file.originalSize > maxBytes) {
                rejectUnzip(
                  new WorkflowRegistrationError(
                    413,
                    `archive entry "${file.name}" uncompressed size ${file.originalSize} exceeds ${maxBytes} bytes`,
                  ),
                )
                return false
              }
              return true
            },
          },
          (err, decoded) => {
            if (err !== null && err !== undefined) {
              rejectUnzip(
                new WorkflowRegistrationError(400, `failed to decode .zip archive: ${err.message}`),
              )
              return
            }
            resolveUnzip(decoded ?? {})
          },
        )
      })
    } catch (err) {
      if (err instanceof WorkflowRegistrationError) throw err
      throw new WorkflowRegistrationError(
        400,
        `failed to decode .zip archive: ${(err as Error).message}`,
      )
    }

    const destDir = this.destinationFor(input.id)
    await mkdir(this.options.uploadRoot, { recursive: true })

    const sanitized = sanitizeEntries(entries, destDir, this.options.maxBytes)
    const entryRelative = chooseEntry(sanitized, input.entry)
    if (entryRelative === undefined) {
      throw new WorkflowRegistrationError(
        400,
        'archive contains no *.workflow.ts or *.pipeline.ts at the root; pass `entry` to override',
      )
    }

    if (input.mode === 'register') {
      if (await isNonEmptyDir(destDir)) {
        throw new WorkflowRegistrationError(
          409,
          `workflow id "${input.id}" already has an extracted archive; use PUT to replace`,
        )
      }
    }

    const stagingDir = `${destDir}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      await writeEntries(stagingDir, sanitized)
      await rm(destDir, { recursive: true, force: true })
      await rename(stagingDir, destDir)
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }

    return {
      extractedDir: destDir,
      entryPath: join(destDir, entryRelative),
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.destinationFor(id), { recursive: true, force: true })
  }
}

interface SanitizedEntry {
  relativePath: string
  data: Uint8Array
}

function sanitizeEntries(
  entries: Record<string, Uint8Array>,
  destRoot: string,
  maxBytes: number,
): SanitizedEntry[] {
  const out: SanitizedEntry[] = []
  let total = 0
  const resolvedRoot = resolve(destRoot)
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    if (name.length === 0) continue
    const normalized = normalize(name)
    if (
      normalized.startsWith('..') ||
      normalized.split(/[\\/]/).includes('..') ||
      isAbsolute(normalized) ||
      normalized.startsWith(sep) ||
      normalized.startsWith('/')
    ) {
      throw new WorkflowRegistrationError(400, `archive entry escapes the extraction root: ${name}`)
    }
    const absolute = resolve(destRoot, normalized)
    if (absolute !== resolvedRoot && !absolute.startsWith(resolvedRoot + sep)) {
      throw new WorkflowRegistrationError(400, `archive entry escapes the extraction root: ${name}`)
    }
    const ext = extOf(normalized)
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new WorkflowRegistrationError(400, `archive entry has disallowed extension: ${name}`)
    }
    total += data.byteLength
    if (total > maxBytes) {
      throw new WorkflowRegistrationError(
        413,
        `archive uncompressed size exceeds ${maxBytes} bytes`,
      )
    }
    out.push({ relativePath: normalized, data })
  }
  return out
}

function chooseEntry(entries: SanitizedEntry[], requested: string | undefined): string | undefined {
  if (requested !== undefined && requested.length > 0) {
    const wanted = normalize(requested)
    const match = entries.find((e) => e.relativePath === wanted)
    if (match === undefined) {
      throw new WorkflowRegistrationError(400, `entry "${requested}" is not in the archive`)
    }
    return match.relativePath
  }
  const rootCandidates = entries.filter((e) => {
    if (e.relativePath.includes(sep) || e.relativePath.includes('/')) return false
    return e.relativePath.endsWith('.workflow.ts') || e.relativePath.endsWith('.pipeline.ts')
  })
  if (rootCandidates.length === 1) {
    return rootCandidates[0]?.relativePath
  }
  return undefined
}

async function writeEntries(stagingDir: string, entries: SanitizedEntry[]): Promise<void> {
  await mkdir(stagingDir, { recursive: true })
  for (const entry of entries) {
    const target = join(stagingDir, entry.relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.data)
  }
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const names = await readdir(dir)
    return names.length > 0
  } catch {
    return false
  }
}

function extOf(name: string): string {
  const base = posix.basename(name.replace(/\\/g, '/'))
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

function hasZipMagic(buf: Uint8Array): boolean {
  if (buf.byteLength < ZIP_MAGIC.byteLength) return false
  for (let i = 0; i < ZIP_MAGIC.byteLength; i++) {
    if (buf[i] !== ZIP_MAGIC[i]) return false
  }
  return true
}
