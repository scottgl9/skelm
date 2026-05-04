import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export interface LockfileContents {
  pid: number
  startedAt: string
}

export class LockfileError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly holder?: LockfileContents,
  ) {
    super(message)
    this.name = 'LockfileError'
  }
}

/**
 * Acquire an exclusive lockfile. If a stale lockfile exists for a PID that
 * no longer holds the process, it is reclaimed; otherwise we throw.
 *
 * The lockfile doubles as the audit-writer claim per planning/21.
 */
export async function acquireLockfile(path: string): Promise<LockfileContents> {
  await fs.mkdir(dirname(path), { recursive: true })
  const contents: LockfileContents = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }
  const payload = JSON.stringify(contents)

  try {
    const handle = await fs.open(path, 'wx')
    try {
      await handle.writeFile(payload)
    } finally {
      await handle.close()
    }
    return contents
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  const existing = await readLockfile(path)
  if (existing && isProcessAlive(existing.pid)) {
    throw new LockfileError(
      `gateway lockfile held by pid ${existing.pid} (started ${existing.startedAt})`,
      path,
      existing,
    )
  }

  await fs.writeFile(path, payload)
  return contents
}

export async function releaseLockfile(path: string): Promise<void> {
  try {
    const existing = await readLockfile(path)
    if (existing && existing.pid !== process.pid) return
    await fs.rm(path, { force: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

export async function readLockfile(path: string): Promise<LockfileContents | null> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<LockfileContents>
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null
    return { pid: parsed.pid, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
