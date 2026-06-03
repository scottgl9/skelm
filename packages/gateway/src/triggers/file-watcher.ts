import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { type FSWatcher, watch } from 'chokidar'

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
  private watcher: FSWatcher | null = null
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
    this.watcher = watch(this.watchedPath, {
      ignoreInitial: false,
      persistent: false,
    })
    this.watcher.on('add', (path) => this.queueEvent('create', this.normalizePath(path), onFire))
    this.watcher.on('addDir', (path) => {
      const changedPath = this.normalizePath(path)
      if (changedPath !== this.watchedPath) this.queueEvent('create', changedPath, onFire)
    })
    this.watcher.on('change', (path) => this.queueEvent('update', this.normalizePath(path), onFire))
    this.watcher.on('unlink', (path) => this.queueEvent('delete', this.normalizePath(path), onFire))
    this.watcher.on('unlinkDir', (path) =>
      this.queueEvent('delete', this.normalizePath(path), onFire),
    )
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pendingEvents.clear()
  }

  private normalizePath(path: string): string {
    if (this.watchedIsFile) return this.watchedPath
    return resolve(path)
  }

  private queueEvent(
    mapped: FileWatchEvent,
    changedPath: string,
    onFire: (payload: FileWatchPayload) => void,
  ): void {
    if (!this.allowedEvents.has(mapped)) return
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
