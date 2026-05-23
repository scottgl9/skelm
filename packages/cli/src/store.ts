import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MemoryRunStore, type SkelmConfig, SqliteRunStore, WorkspaceManager } from '@skelm/core'

export type CliRunStore = MemoryRunStore | SqliteRunStore

/** Default SQLite path — shared with the gateway so CLI runs appear in history.
 * Respects SKELM_STATE_DIR env override (same as the gateway).
 */
const DEFAULT_DB_PATH = join(process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm'), 'runs.db')

export function createRunStore(config: SkelmConfig): CliRunStore {
  const storage = config.storage
  if (storage?.runs?.driver === 'memory' || storage?.state?.driver === 'memory') {
    return new MemoryRunStore()
  }
  const path = resolveStoragePath(storage?.state?.path ?? storage?.runs?.path) ?? DEFAULT_DB_PATH
  return new SqliteRunStore({ path })
}

export function createWorkspaceManager(config: SkelmConfig): WorkspaceManager {
  return new WorkspaceManager({
    ...(config.storage?.workspaces?.base !== undefined && {
      persistentBase: config.storage.workspaces.base,
    }),
    ...(config.storage?.workspaces?.ephemeralBase !== undefined && {
      ephemeralBase: config.storage.workspaces.ephemeralBase,
    }),
  })
}

export function closeRunStore(store: CliRunStore): void {
  if ('close' in store && typeof store.close === 'function') {
    store.close()
  }
}

function resolveStoragePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2))
  }
  return resolve(path)
}
