/**
 * Bounded-concurrency semaphore. Returns `{ acquire, release }` that backends
 * use to cap simultaneous in-flight requests (subprocess spawns, in-process
 * model calls, etc.) without unbounded fan-out.
 *
 * `maxConcurrent === 0` disables the cap entirely. FIFO ordering of waiters.
 */
export interface ConcurrencySemaphore {
  acquire(): Promise<void>
  release(): void
}

export function createConcurrencySemaphore(maxConcurrent: number): ConcurrencySemaphore {
  let active = 0
  const queue: Array<() => void> = []

  return {
    acquire(): Promise<void> {
      if (maxConcurrent === 0 || active < maxConcurrent) {
        active++
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => queue.push(resolve))
    },
    release(): void {
      const next = queue.shift()
      if (next) next()
      else active--
    },
  }
}
