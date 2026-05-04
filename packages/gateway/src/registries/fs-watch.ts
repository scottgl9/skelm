import { type FSWatcher, watch } from 'node:fs'

export interface FsWatchOptions {
  /** Absolute path to a directory to watch recursively. */
  dir: string
  /** Debounce window in ms before firing the change handler. */
  debounceMs?: number
  onChange: () => void
}

/**
 * Thin wrapper around node:fs.watch with debouncing. The recursive option
 * is supported on macOS / Windows / Linux 6.5+ — older Linux falls back to
 * a single-level watch. Either way, refresh() can always be called manually.
 */
export class FsWatcher {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly options: FsWatchOptions) {}

  start(): void {
    if (this.watcher !== null) return
    try {
      this.watcher = watch(this.options.dir, { recursive: true }, () => this.schedule())
    } catch {
      try {
        this.watcher = watch(this.options.dir, () => this.schedule())
      } catch {
        this.watcher = null
      }
    }
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
