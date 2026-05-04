import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export interface DiscoveryRecord {
  pid: number
  url: string
  token?: string | undefined
  startedAt: string
}

export async function writeDiscovery(path: string, record: DiscoveryRecord): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 })
}

export async function readDiscovery(path: string): Promise<DiscoveryRecord | null> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DiscoveryRecord>
    if (typeof parsed.pid !== 'number' || typeof parsed.url !== 'string') return null
    return {
      pid: parsed.pid,
      url: parsed.url,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export async function removeDiscovery(path: string): Promise<void> {
  try {
    await fs.rm(path, { force: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
