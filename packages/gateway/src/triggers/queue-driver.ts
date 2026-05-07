/**
 * Queue trigger driver contract. The coordinator looks up a driver by id
 * from the registered drivers map and starts it with an onMessage callback
 * that fires the bound trigger. Implementations bridge external message
 * sources (in-memory test queue, bullmq, SQS, Redis Streams, Telegram
 * long-poll, ...) into the coordinator without coupling the coordinator to
 * any specific transport.
 */
export interface QueueDriver {
  /**
   * Begin delivering messages. The coordinator passes a single onMessage
   * callback per binding; the driver invokes it for each new message.
   * Drivers may forward an optional payload — when provided, it flows
   * through to the dispatched pipeline as input. Errors thrown by onMessage
   * propagate back; drivers may swallow or log but should not retry
   * indefinitely without an explicit policy.
   */
  start(opts: {
    config?: Record<string, unknown>
    onMessage: (payload?: unknown) => Promise<void>
  }): Promise<void> | void
  /** Release any resources (timers, connections, file handles). */
  stop(): Promise<void> | void
  /**
   * Optional hook invoked by the dispatcher after the workflow run resolves.
   * Drivers that need to react to the run output (e.g. post a reply back to
   * the originating chat) implement this. The payload argument is the same
   * object passed to onMessage; the output is the pipeline's resolved
   * output, or undefined if the run failed.
   */
  onResult?(payload: unknown, output: unknown): Promise<void> | void
}

/**
 * Reference in-memory queue driver. Messages pushed via push() invoke the
 * registered onMessage immediately on the next microtask. Useful in tests
 * and as a baseline for verifying the queue trigger plumbing without
 * external infrastructure.
 */
export class InMemoryQueueDriver implements QueueDriver {
  private onMessage: ((payload?: unknown) => Promise<void>) | null = null
  private pending: Array<unknown> = []

  start(opts: { onMessage: (payload?: unknown) => Promise<void> }): void {
    this.onMessage = opts.onMessage
    if (this.pending.length > 0) {
      const drain = this.pending.slice()
      this.pending = []
      void (async () => {
        for (const msg of drain) {
          await this.onMessage?.(msg)
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
    void this.onMessage(payload)
  }

  stop(): void {
    this.onMessage = null
    this.pending = []
  }
}
