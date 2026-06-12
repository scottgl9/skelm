import { readdirSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
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
  private pollTimer: NodeJS.Timeout | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private pendingEvents = new Map<string, FileWatchEvent>()
  private usingPollingFallback = false
  private pollSnapshot = new Map<string, string>()
  private readonly watchedPath: string
  private readonly watchedIsFile: boolean
  private readonly allowedEvents: ReadonlySet<FileWatchEvent>
  private readonly debounceMs: number

  constructor(private readonly spec: FileWatchTriggerSpec) {
    this.watchedPath = resolve(spec.path)
    this.watchedIsFile = statSync(this.watchedPath).isFile()
    this.allowedEvents = new Set(spec.events ?? DEFAULT_EVENTS)
    this.debounceMs = spec.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  start(onFire: (payload: FileWatchPayload) => void, onError?: (err: Error) => void): void {
    this.stop()
    this.pollSnapshot = captureSnapshotSync(this.watchedPath, this.watchedIsFile)
    this.startWatcher(onFire, onError, false)
  }

  private startWatcher(
    onFire: (payload: FileWatchPayload) => void,
    onError: ((err: Error) => void) | undefined,
    usePolling: boolean,
  ): void {
    this.usingPollingFallback = usePolling
    this.watcher = watch(this.watchedPath, {
      ignoreInitial: true,
      persistent: true,
      usePolling,
      ...(usePolling ? { interval: 50 } : {}),
    })
    const queueWatchedEvent = (event: FileWatchEvent, path: string) => {
      this.queueEvent(event, this.normalizePath(path), onFire)
    }
    this.watcher.on('add', (path) => queueWatchedEvent('create', path))
    this.watcher.on('addDir', (path) => {
      const changedPath = this.normalizePath(path)
      if (changedPath !== this.watchedPath) queueWatchedEvent('create', path)
    })
    this.watcher.on('change', (path) => queueWatchedEvent('update', path))
    this.watcher.on('unlink', (path) => queueWatchedEvent('delete', path))
    this.watcher.on('unlinkDir', (path) => queueWatchedEvent('delete', path))
    this.watcher.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err))
      if (!this.usingPollingFallback && error.message.includes('ENOSPC')) {
        onError?.(error)
        this.watcher?.close().catch(() => {})
        this.watcher = null
        void this.startPollingFallback(onFire, onError)
        return
      }
      onError?.(error)
    })
  }

  private async startPollingFallback(
    onFire: (payload: FileWatchPayload) => void,
    onError?: (err: Error) => void,
  ): Promise<void> {
    this.usingPollingFallback = true
    this.pollTimer = setInterval(() => {
      void this.pollOnce(onFire, onError)
    }, 50)
    this.pollTimer.unref?.()
  }

  private async pollOnce(
    onFire: (payload: FileWatchPayload) => void,
    onError?: (err: Error) => void,
  ): Promise<void> {
    try {
      const next = await this.captureSnapshot()
      const previous = this.pollSnapshot
      for (const [path, stamp] of next) {
        const last = previous.get(path)
        if (last === undefined) this.queueEvent('create', path, onFire)
        else if (last !== stamp) this.queueEvent('update', path, onFire)
      }
      for (const path of previous.keys()) {
        if (!next.has(path)) this.queueEvent('delete', path, onFire)
      }
      this.pollSnapshot = next
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async captureSnapshot(): Promise<Map<string, string>> {
    try {
      const snapshot = new Map<string, string>()
      if (this.watchedIsFile) {
        const info = await stat(this.watchedPath)
        snapshot.set(this.watchedPath, snapshotStamp(info.isDirectory(), info.mtimeMs, info.size))
        return snapshot
      }
      await walkDirectory(this.watchedPath, snapshot)
      return snapshot
    } catch (err) {
      if (isMissingPathError(err)) return new Map()
      throw err
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.usingPollingFallback = false
    this.pollSnapshot.clear()
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
    if (!this.watchedIsFile && changedPath === this.watchedPath && mapped === 'update') return
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

async function walkDirectory(dir: string, snapshot: Map<string, string>): Promise<void> {
  const dirInfo = await stat(dir)
  snapshot.set(dir, snapshotStamp(true, dirInfo.mtimeMs, dirInfo.size))
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDirectory(path, snapshot)
      continue
    }
    const info = await stat(path)
    snapshot.set(path, snapshotStamp(false, info.mtimeMs, info.size))
  }
}

function captureSnapshotSync(path: string, watchedIsFile: boolean): Map<string, string> {
  const snapshot = new Map<string, string>()
  if (watchedIsFile) {
    const info = statSync(path)
    snapshot.set(path, snapshotStamp(info.isDirectory(), info.mtimeMs, info.size))
    return snapshot
  }
  walkDirectorySync(path, snapshot)
  return snapshot
}

function walkDirectorySync(dir: string, snapshot: Map<string, string>): void {
  const dirInfo = statSync(dir)
  snapshot.set(dir, snapshotStamp(true, dirInfo.mtimeMs, dirInfo.size))
  const entries = dirInfo.isDirectory() ? readdirSync(dir, { withFileTypes: true }) : []
  for (const entry of entries) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      walkDirectorySync(path, snapshot)
      continue
    }
    const info = statSync(path)
    snapshot.set(path, snapshotStamp(false, info.mtimeMs, info.size))
  }
}

function snapshotStamp(isDirectory: boolean, mtimeMs: number, size: number): string {
  return isDirectory ? `dir:${mtimeMs}` : `file:${mtimeMs}:${size}`
}

function isMissingPathError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')
}
