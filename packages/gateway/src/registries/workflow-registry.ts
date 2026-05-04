import { isAbsolute, join, resolve } from 'node:path'
import { BaseRegistry } from './base.js'
import { FsWatcher } from './fs-watch.js'
import { walkGlob } from './glob.js'

/**
 * Registry of workflow source files discovered on disk. Phase 3 records
 * paths only; workflow modules are imported lazily by the runner the first
 * time they are referenced. The registry id is the path relative to the
 * project root.
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

  constructor(private readonly options: WorkflowRegistryOptions) {
    super()
    const root = options.projectRoot
    const segment = options.glob.split('*')[0] ?? ''
    const rel = segment.replace(/\/$/, '')
    this.scanRoot = isAbsolute(rel) ? rel : resolve(root, rel === '' ? '.' : rel)
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
    return files.map((path) => ({
      id: path.slice(this.options.projectRoot.length).replace(/^\/+/, '').replace(/\\/g, '/'),
      path,
    }))
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
