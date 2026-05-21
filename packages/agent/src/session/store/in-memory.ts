import type { SerializedSession } from '../agent-session.js'
import type { SessionStore } from './types.js'

export class InMemorySessionStore implements SessionStore {
  private readonly map = new Map<string, SerializedSession>()

  async save(id: string, session: SerializedSession): Promise<void> {
    this.map.set(id, structuredClone(session))
  }

  async load(id: string): Promise<SerializedSession | undefined> {
    const found = this.map.get(id)
    return found === undefined ? undefined : structuredClone(found)
  }

  async list(): Promise<string[]> {
    return [...this.map.keys()]
  }

  async delete(id: string): Promise<boolean> {
    return this.map.delete(id)
  }
}
