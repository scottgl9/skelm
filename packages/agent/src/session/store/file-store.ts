import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SerializedSession } from '../agent-session.js'
import type { SessionStore } from './types.js'

/**
 * Stores each session as `<dir>/<id>.json`. Suitable for local scripts and
 * tests; pipelines running under the gateway should rely on the run store
 * for durability instead.
 */
export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    if (id.includes('/') || id.includes('\\') || id.startsWith('.')) {
      throw new Error(`invalid session id: ${id}`)
    }
    return join(this.dir, `${id}.json`)
  }

  async save(id: string, session: SerializedSession): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.path(id), JSON.stringify(session, null, 2), 'utf8')
  }

  async load(id: string): Promise<SerializedSession | undefined> {
    try {
      const raw = await readFile(this.path(id), 'utf8')
      return JSON.parse(raw) as SerializedSession
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir)
      return entries.filter((e) => e.endsWith('.json')).map((e) => e.slice(0, -5))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.path(id))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }
}
