import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { SecretResolver } from '@skelm/core'

/**
 * File-backed secret driver. Stores secrets as a JSON object at a path
 * (default ~/.skelm/secrets.json) with mode 0600. Resolution returns the
 * value or undefined; the gateway is responsible for auditing the *name*
 * of every resolution.
 *
 * Writes are atomic (tmp-file + fsync + rename) and serialized through
 * a per-instance mutex so two concurrent set()/unset() calls in the
 * same process can't clobber each other's read-modify-write window.
 * Cross-process safety still requires the gateway lockfile.
 */
export class FileSecretResolver implements SecretResolver {
  private writeQueue: Promise<void> = Promise.resolve()
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
    await this.serialize(async () => {
      const all = await this.readAll()
      all[name] = value
      await this.writeAll(all)
    })
  }

  async unset(name: string): Promise<boolean> {
    return this.serialize(async () => {
      const all = await this.readAll()
      if (!(name in all)) return false
      delete all[name]
      await this.writeAll(all)
      return true
    })
  }

  /**
   * Serialize a read-modify-write block against the in-memory queue so
   * concurrent set()/unset() callers in the same process observe each
   * other's writes. The returned promise resolves with the block's value.
   */
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue
    let resolveSlot!: () => void
    this.writeQueue = new Promise<void>((resolve) => {
      resolveSlot = resolve
    })
    try {
      await previous.catch(() => {})
      return await fn()
    } finally {
      resolveSlot()
    }
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

  /**
   * Atomic write via tmp-file + fsync + rename. A crash mid-write leaves
   * either the previous file intact or no tmp file (cleaned up on retry);
   * never a half-written secrets store.
   */
  private async writeAll(all: Record<string, string>): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`
    const body = JSON.stringify(all, null, 2)
    const fh = await fs.open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(body)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, this.path)
  }
}
