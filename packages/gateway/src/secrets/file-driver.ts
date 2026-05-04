import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { SecretResolver } from '@skelm/core'

/**
 * File-backed secret driver. Stores secrets as a JSON object at a path
 * (default ~/.skelm/secrets.json) with mode 0600. Resolution returns the
 * value or undefined; the gateway is responsible for auditing the *name*
 * of every resolution.
 */
export class FileSecretResolver implements SecretResolver {
  constructor(private readonly path: string) {}

  async resolve(name: string): Promise<string | undefined> {
    const all = await this.readAll()
    return all[name]
  }

  async list(): Promise<string[]> {
    const all = await this.readAll()
    return Object.keys(all).sort()
  }

  async set(name: string, value: string): Promise<void> {
    const all = await this.readAll()
    all[name] = value
    await this.writeAll(all)
  }

  async unset(name: string): Promise<boolean> {
    const all = await this.readAll()
    if (!(name in all)) return false
    delete all[name]
    await this.writeAll(all)
    return true
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
  }

  private async writeAll(all: Record<string, string>): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    await fs.writeFile(this.path, JSON.stringify(all, null, 2), { mode: 0o600 })
  }
}
