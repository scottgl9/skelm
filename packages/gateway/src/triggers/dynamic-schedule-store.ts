import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OverlapPolicy, TriggerRegistration, TriggerSpec } from './types.js'

export interface PersistedDynamicSchedule {
  spec: TriggerSpec
  overlap: OverlapPolicy
  input?: unknown
  nextFireAt?: string
}

export class DynamicScheduleStore {
  readonly path: string
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(stateDir: string) {
    this.path = join(stateDir, 'dynamic-schedules.json')
  }

  async list(): Promise<PersistedDynamicSchedule[]> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPersistedDynamicSchedule)
  }

  async upsert(registration: TriggerRegistration): Promise<void> {
    await this.queueWrite(async () => {
      const records = await this.list()
      const record: PersistedDynamicSchedule = {
        spec: registration.spec,
        overlap: registration.overlap,
        ...(registration.input !== undefined && { input: registration.input }),
        ...(registration.nextFireAt !== undefined && { nextFireAt: registration.nextFireAt }),
      }
      const next = records.filter((item) => item.spec.id !== registration.spec.id)
      next.push(record)
      await this.write(next)
    })
  }

  async delete(id: string): Promise<void> {
    await this.queueWrite(async () => {
      const records = await this.list()
      const next = records.filter((item) => item.spec.id !== id)
      if (next.length === 0) {
        try {
          await unlink(this.path)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
        return
      }
      await this.write(next)
    })
  }

  private queueWrite(fn: () => Promise<void>): Promise<void> {
    const prev = this.pendingWrite
    this.pendingWrite = prev.then(fn, fn)
    return this.pendingWrite
  }

  private async write(records: PersistedDynamicSchedule[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
  }
}

function isPersistedDynamicSchedule(value: unknown): value is PersistedDynamicSchedule {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as {
    spec?: unknown
    overlap?: unknown
  }
  if (!['skip', 'queue', 'cancel'].includes(String(candidate.overlap))) return false
  if (candidate.spec === null || typeof candidate.spec !== 'object') return false
  const spec = candidate.spec as Partial<TriggerSpec>
  return (
    typeof spec.id === 'string' &&
    typeof spec.workflowId === 'string' &&
    typeof spec.kind === 'string'
  )
}
