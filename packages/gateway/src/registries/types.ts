/**
 * Shape every gateway registry shares: indexed by string id, supports
 * list / get, and emits change events the gateway can hook into.
 */

export interface RegistryChange<T> {
  added: T[]
  removed: T[]
  modified: T[]
}

export type RegistryListener<T> = (change: RegistryChange<T>) => void

export interface Registry<T extends { id: string }> {
  list(): T[]
  get(id: string): T | undefined
  on(event: 'change', listener: RegistryListener<T>): () => void
  /** Re-read the underlying source and emit a change event if anything moved. */
  refresh(): Promise<RegistryChange<T>>
  /** Stop watching and release resources. */
  close(): Promise<void>
}
