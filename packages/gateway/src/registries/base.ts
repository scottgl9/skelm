import type { Registry, RegistryChange, RegistryListener } from './types.js'

/**
 * Shared bookkeeping for in-memory registries: holds the current entry map,
 * computes diffs against incoming snapshots, and dispatches change events.
 *
 * Subclasses implement `loadSnapshot()` and call `applySnapshot()` whenever
 * their underlying source moves (config reload, FS event).
 */
export abstract class BaseRegistry<T extends { id: string }> implements Registry<T> {
  protected entries: Map<string, T> = new Map()
  private listeners: Set<RegistryListener<T>> = new Set()

  list(): T[] {
    return Array.from(this.entries.values())
  }

  get(id: string): T | undefined {
    return this.entries.get(id)
  }

  on(event: 'change', listener: RegistryListener<T>): () => void {
    if (event !== 'change') {
      throw new Error(`unknown registry event: ${event}`)
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async refresh(): Promise<RegistryChange<T>> {
    const next = await this.loadSnapshot()
    return this.applySnapshot(next)
  }

  async close(): Promise<void> {
    this.listeners.clear()
  }

  protected applySnapshot(snapshot: T[]): RegistryChange<T> {
    const next = new Map<string, T>()
    for (const entry of snapshot) next.set(entry.id, entry)

    const added: T[] = []
    const removed: T[] = []
    const modified: T[] = []

    for (const [id, entry] of next) {
      const prev = this.entries.get(id)
      if (prev === undefined) {
        added.push(entry)
      } else if (!entriesEqual(prev, entry)) {
        modified.push(entry)
      }
    }
    for (const [id, entry] of this.entries) {
      if (!next.has(id)) removed.push(entry)
    }

    this.entries = next
    if (added.length > 0 || removed.length > 0 || modified.length > 0) {
      const change: RegistryChange<T> = { added, removed, modified }
      for (const listener of this.listeners) listener(change)
    }
    return { added, removed, modified }
  }

  protected abstract loadSnapshot(): Promise<T[]>
}

function entriesEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
