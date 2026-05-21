import { constants as fsConstants, statSync, watch } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

export type FileWatchEvent = 'create' | 'update' | 'delete'

export interface FileWatchTriggerSpec {
  path: string
  events?: readonly FileWatchEvent[]
  debounceMs?: number
}

export interface FileWatchPayload {
  path: string
  event: FileWatchEvent
  watchedPath: string
  firedAt: string
}

const DEFAULT_EVENTS: readonly FileWatchEvent[] = ['create', 'update', 'delete']
const DEFAULT_DEBOUNCE_MS = 100

export class FileWatchTrigger {
  private watcher: ReturnType<typeof watch> | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private pendingEvents = new Map<string, FileWatchEvent>()
  private readonly watchedPath: string
  private readonly watchedIsFile: boolean
  private readonly allowedEvents: ReadonlySet<FileWatchEvent>
  private readonly debounceMs: number

  constructor(private readonly spec: FileWatchTriggerSpec) {
    this.watchedPath = resolve(spec.path)
    this.watchedIsFile = isFileSafe(this.watchedPath)
    this.allowedEvents = new Set(spec.events ?? DEFAULT_EVENTS)
    this.debounceMs = spec.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  start(onFire: (payload: FileWatchPayload) => void): void {
    this.stop()
    this.watcher = watch(
      this.watchedPath,
      { recursive: true, persistent: false },
      (eventType, filename) => {
        const changedPath = this.resolveChangedPath(filename)
        void this.queueEvent(eventType, changedPath, onFire)
      },
    )
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pendingEvents.clear()
  }

  private resolveChangedPath(filename: string | Buffer | null): string {
    // Single-file watches: fs.watch reports filename === basename(file), which
    // join()d to a file path produces "/dir/file/file" — return the file path.
    if (this.watchedIsFile) return this.watchedPath
    if (filename === null) return this.watchedPath
    const relative = filename.toString()
    if (relative === '') return this.watchedPath
    return isAbsolute(relative) ? relative : join(this.watchedPath, relative)
  }

  private async queueEvent(
    eventType: 'rename' | 'change',
    changedPath: string,
    onFire: (payload: FileWatchPayload) => void,
  ): Promise<void> {
    const mapped = await this.mapEvent(eventType, changedPath)
    if (mapped === null || !this.allowedEvents.has(mapped)) return
    const key = changedPath
    this.pendingEvents.set(key, mergeEvents(this.pendingEvents.get(key), mapped))
    const existing = this.timers.get(key)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      const event = this.pendingEvents.get(key)
      this.pendingEvents.delete(key)
      if (event === undefined) return
      onFire({
        path: changedPath,
        event,
        watchedPath: this.watchedPath,
        firedAt: new Date().toISOString(),
      })
    }, this.debounceMs)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  private async mapEvent(
    eventType: 'rename' | 'change',
    changedPath: string,
  ): Promise<FileWatchEvent | null> {
    if (eventType === 'change') return 'update'
    if (eventType !== 'rename') return null
    return (await this.exists(changedPath)) ? 'create' : 'delete'
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path, fsConstants.F_OK)
      return true
    } catch {
      // Linux fs.watch rename events on a watched file path sometimes report
      // the parent filename rather than the full file path; retry the root
      // path when the basename matches.
      //
      // Known limitation: if another file with the same basename exists at
      // watchedPath, a delete here can be misreported as a create. The
      // common directory-watch case (recursive watch over a folder) is not
      // affected; a file-watch over a sibling that shares the watched
      // file's name is.
      if (basename(path) === basename(this.watchedPath) && path !== this.watchedPath) {
        try {
          await access(this.watchedPath, fsConstants.F_OK)
          return true
        } catch {
          return false
        }
      }
      return false
    }
  }
}

function mergeEvents(
  existing: FileWatchEvent | undefined,
  incoming: FileWatchEvent,
): FileWatchEvent {
  if (existing === undefined) return incoming
  if (existing === incoming) return existing
  if (incoming === 'delete' || existing === 'delete') return 'delete'
  if (incoming === 'create' || existing === 'create') return 'create'
  return incoming
}

function isFileSafe(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
