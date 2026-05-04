/**
 * Queue trigger driver contract. The coordinator looks up a driver by id
 * from the registered drivers map and starts it with an onMessage callback
 * that fires the bound trigger. Implementations bridge external message
 * sources (in-memory test queue, bullmq, SQS, Redis Streams, ...) into the
 * coordinator without coupling the coordinator to any specific transport.
 */
export interface QueueDriver {
  /**
   * Begin delivering messages. The coordinator passes a single onMessage
   * callback per binding; the driver invokes it for each new message.
   * Errors thrown by onMessage propagate back; drivers may swallow or log
   * but should not retry indefinitely without an explicit policy.
   */
  start(opts: {
    config?: Record<string, unknown>
    onMessage: () => Promise<void>
  }): Promise<void> | void
  /** Release any resources (timers, connections, file handles). */
  stop(): Promise<void> | void
}

/**
 * Reference in-memory queue driver. Messages pushed via push() invoke the
 * registered onMessage immediately on the next microtask. Useful in tests
 * and as a baseline for verifying the queue trigger plumbing without
 * external infrastructure.
 */
export class InMemoryQueueDriver implements QueueDriver {
  private onMessage: (() => Promise<void>) | null = null
  private pending: Array<unknown> = []

  start(opts: { onMessage: () => Promise<void> }): void {
    this.onMessage = opts.onMessage
    // Drain any messages enqueued before start().
    if (this.pending.length > 0) {
      const drain = this.pending.slice()
      this.pending = []
      void (async () => {
        for (const _msg of drain) {
          await this.onMessage?.()
        }
      })()
    }
  }

  /** Enqueue a message. If start() has run, dispatched on the next microtask. */
  push(payload?: unknown): void {
    if (this.onMessage === null) {
      this.pending.push(payload)
      return
    }
    void this.onMessage()
  }

  stop(): void {
    this.onMessage = null
    this.pending = []
  }
}
