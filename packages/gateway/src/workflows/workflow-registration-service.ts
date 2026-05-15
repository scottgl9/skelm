import { mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { WorkflowEntry, WorkflowRegistry } from '../registries/workflow-registry.js'

/**
 * Persisted record for a workflow registered via POST /v1/workflows/register.
 * One JSON file per id lives under `${stateDir}/registered-workflows/`.
 */
export interface RegisteredWorkflowRecord {
  id: string
  sourcePath: string
  /** Where the source came from: a host filesystem path or an extracted archive. */
  sourceKind?: 'path' | 'archive'
  description?: string
  version?: string
  registeredAt: string
}

export interface WorkflowRegistrationServiceOptions {
  /** Directory holding per-id JSON files. */
  stateDir: string
  registry: WorkflowRegistry
  /** Project root — registrations rooted here are always allowed. */
  projectRoot: string
  /** Additional permitted source roots (resolved to realpath at check time). */
  allowedDirs: string[]
  /**
   * Gateway-owned root for extracted workflow archives. Always treated as an
   * allowed source root since the gateway itself controls the contents.
   */
  archiveRoot?: string
}

export class WorkflowRegistrationError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowRegistrationError'
  }
}

/**
 * Owns explicit workflow registrations: path safety, on-disk persistence,
 * and propagation into the gateway's WorkflowRegistry so the rest of the
 * HTTP surface (`/pipelines`, `/pipelines/:id/run`, dashboard, …) sees them.
 */
export class WorkflowRegistrationService {
  private readonly dir: string

  constructor(private readonly options: WorkflowRegistrationServiceOptions) {
    this.dir = join(options.stateDir, 'registered-workflows')
  }

  /** Replay persisted registrations into the WorkflowRegistry. Safe to call once at boot. */
  async loadFromDisk(): Promise<RegisteredWorkflowRecord[]> {
    await mkdir(this.dir, { recursive: true })
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const records: RegisteredWorkflowRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.dir, name)
      try {
        const text = await readFile(path, 'utf8')
        const rec = JSON.parse(text) as RegisteredWorkflowRecord
        if (typeof rec.id === 'string' && typeof rec.sourcePath === 'string') {
          records.push(rec)
        } else {
          // Visible to operators so a corrupted record doesn't make a workflow
          // silently vanish across a restart.
          console.warn(`[skelm] workflow registration record missing required fields: ${path}`)
        }
      } catch (err) {
        console.warn(
          `[skelm] failed to read workflow registration record ${path}: ${(err as Error).message}`,
        )
      }
    }
    await this.options.registry.setRegistered(
      records.map((r) => ({ id: r.id, path: r.sourcePath })),
    )
    return records
  }

  /** Resolve a candidate path to an absolute realpath and verify it sits inside an allowed root. */
  async resolveSourcePath(candidate: string): Promise<string> {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new WorkflowRegistrationError(400, 'source.path is required')
    }
    const abs = isAbsolute(candidate) ? candidate : resolve(this.options.projectRoot, candidate)
    let real: string
    try {
      real = await realpath(abs)
    } catch (err) {
      throw new WorkflowRegistrationError(
        400,
        `cannot resolve source path: ${(err as Error).message}`,
      )
    }
    const roots = [
      this.options.projectRoot,
      ...this.options.allowedDirs,
      ...(this.options.archiveRoot !== undefined ? [this.options.archiveRoot] : []),
    ]
    const resolvedRoots = await Promise.all(
      roots.map(async (r) => {
        try {
          return await realpath(r)
        } catch {
          return resolve(r)
        }
      }),
    )
    const within = resolvedRoots.some((root) => isWithin(real, root))
    if (!within) {
      throw new WorkflowRegistrationError(
        400,
        'source.path is outside the allowed registration roots',
      )
    }
    return real
  }

  validateId(id: unknown): string {
    if (typeof id !== 'string' || id.length === 0) {
      throw new WorkflowRegistrationError(400, 'id is required')
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(id) || id.includes('..')) {
      throw new WorkflowRegistrationError(
        400,
        'id may contain only letters, digits, dot, underscore, hyphen, slash; no ".." segments',
      )
    }
    return id
  }

  /** Persist a record to disk and register it with the workflow registry. */
  async upsert(input: {
    id: string
    sourcePath: string
    sourceKind?: 'path' | 'archive'
    description?: string
    version?: string
  }): Promise<RegisteredWorkflowRecord> {
    await mkdir(this.dir, { recursive: true })
    const record: RegisteredWorkflowRecord = {
      id: input.id,
      sourcePath: input.sourcePath,
      sourceKind: input.sourceKind ?? 'path',
      ...(input.description !== undefined && { description: input.description }),
      ...(input.version !== undefined && { version: input.version }),
      registeredAt: new Date().toISOString(),
    }
    await writeFile(this.recordPath(record.id), JSON.stringify(record, null, 2), 'utf8')
    await this.options.registry.addRegistered({ id: record.id, path: record.sourcePath })
    return record
  }

  /** Read a persisted record by id without touching the registry. Returns undefined if missing. */
  async getRecord(id: string): Promise<RegisteredWorkflowRecord | undefined> {
    try {
      const text = await readFile(this.recordPath(id), 'utf8')
      return JSON.parse(text) as RegisteredWorkflowRecord
    } catch {
      return undefined
    }
  }

  /** Remove a registration from disk and from the registry. */
  async remove(id: string): Promise<boolean> {
    let removedFile = false
    try {
      await unlink(this.recordPath(id))
      removedFile = true
    } catch {
      // not on disk — still attempt registry removal
    }
    const removedRegistry = await this.options.registry.removeRegistered(id)
    return removedFile || removedRegistry
  }

  list(): WorkflowEntry[] {
    return this.options.registry.listRegistered()
  }

  private recordPath(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`)
  }
}

function isWithin(target: string, root: string): boolean {
  const normRoot = root.endsWith(sep) ? root : `${root}${sep}`
  return target === root || target.startsWith(normRoot)
}
