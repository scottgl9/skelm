import { type FSWatcher, watch } from 'chokidar'

export interface FsWatchOptions {
  /** Absolute path to a directory to watch recursively. */
  dir: string
  /** Debounce window in ms before firing the change handler. */
  debounceMs?: number
  onChange: () => void
}

/**
 * Thin wrapper around chokidar with debouncing. Watcher errors are best-effort:
 * manual refresh remains available when the platform cannot keep a watcher.
 */
export class FsWatcher {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly options: FsWatchOptions) {}

  start(): void {
    if (this.watcher !== null) return
    this.watcher = watch(this.options.dir, {
      ignoreInitial: true,
      persistent: false,
    })
    this.watcher.on('add', () => this.schedule())
    this.watcher.on('change', () => this.schedule())
    this.watcher.on('unlink', () => this.schedule())
    this.watcher.on('addDir', () => this.schedule())
    this.watcher.on('unlinkDir', () => this.schedule())
    this.watcher?.on('error', () => {
      // Swallow watcher errors; manual refresh remains available.
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.watcher?.close()
    this.watcher = null
  }

  private schedule(): void {
    if (this.closed) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.options.onChange()
    }, this.options.debounceMs ?? 100)
  }
}
