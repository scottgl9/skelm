import { isAbsolute, join, resolve } from 'node:path'
import { BaseRegistry } from './base.js'
import { FsWatcher } from './fs-watch.js'
import { walkGlob } from './glob.js'

/**
 * Registry of workflow source files discovered on disk. Stores paths only;
 * workflow modules are imported lazily by the runner the first time they are
 * referenced. The registry id is the path relative to the project root.
 */
export interface WorkflowEntry {
  id: string
  /** Absolute path to the workflow source file. */
  path: string
}

export interface WorkflowRegistryOptions {
  projectRoot: string
  glob: string
  watch?: boolean
}

export class WorkflowRegistry extends BaseRegistry<WorkflowEntry> {
  private watcher: FsWatcher | null = null
  private readonly scanRoot: string
  /**
   * Workflows added explicitly via the registration service (POST
   * /v1/workflows/register). Merged into every snapshot so subsequent FS
   * refreshes don't drop them. On id collision with a glob-discovered
   * workflow, the registered entry wins.
   */
  private readonly registered: Map<string, WorkflowEntry> = new Map()

  constructor(private readonly options: WorkflowRegistryOptions) {
    super()
    const root = options.projectRoot
    const segment = options.glob.split('*')[0] ?? ''
    const rel = segment.replace(/\/$/, '')
    this.scanRoot = isAbsolute(rel) ? rel : resolve(root, rel === '' ? '.' : rel)
  }

  /** Register or replace an explicit workflow entry; refreshes the snapshot. */
  async addRegistered(entry: WorkflowEntry): Promise<void> {
    this.registered.set(entry.id, entry)
    await this.refresh()
  }

  /** Remove a registered workflow; refreshes the snapshot. Returns true when an entry was removed. */
  async removeRegistered(id: string): Promise<boolean> {
    const had = this.registered.delete(id)
    if (had) await this.refresh()
    return had
  }

  /** Snapshot of the explicit registrations (not glob discovery). */
  listRegistered(): WorkflowEntry[] {
    return Array.from(this.registered.values())
  }

  /** Bulk-replace the registered set (used for boot-time replay from disk). */
  async setRegistered(entries: WorkflowEntry[]): Promise<void> {
    this.registered.clear()
    for (const entry of entries) this.registered.set(entry.id, entry)
    await this.refresh()
  }

  async start(): Promise<void> {
    await this.refresh()
    if (this.options.watch) {
      this.watcher = new FsWatcher({
        dir: this.scanRoot,
        onChange: () => {
          void this.refresh().catch(() => {
            /* ignore — watcher errors are best-effort */
          })
        },
      })
      this.watcher.start()
    }
  }

  override async close(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    await super.close()
  }

  protected async loadSnapshot(): Promise<WorkflowEntry[]> {
    const files = await walkGlob(this.options.projectRoot, this.options.glob)
    const discovered: WorkflowEntry[] = files.map((path) => ({
      id: path.slice(this.options.projectRoot.length).replace(/^\/+/, '').replace(/\\/g, '/'),
      path,
    }))
    // Registered entries shadow discovered ones with the same id.
    const merged: Map<string, WorkflowEntry> = new Map()
    for (const entry of discovered) merged.set(entry.id, entry)
    for (const entry of this.registered.values()) merged.set(entry.id, entry)
    return Array.from(merged.values())
  }

  /** Absolute directory the watcher monitors. Exposed for tests. */
  getScanRoot(): string {
    return this.scanRoot
  }

  /** Convenience for callers that build paths relative to project root. */
  static absolutePath(projectRoot: string, id: string): string {
    return join(projectRoot, id)
  }
}
