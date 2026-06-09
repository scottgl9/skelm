import type { EventBus } from '@skelm/core'

/**
 * Encapsulates the optional metrics and OpenTelemetry wiring for the gateway.
 * Isolates the dynamic imports of @skelm/metrics and @skelm/otel so they are
 * only pulled in when their respective options are enabled.
 */
export class GatewayObservability {
  #metrics: import('@skelm/metrics').MetricsCollector | null = null
  #otelAttach: ((events: EventBus) => { dispose(): void }) | null = null
  #otelDisposers: Array<{ dispose(): void }> = []

  /** The metrics collector, or null when metrics are disabled. */
  get collector(): import('@skelm/metrics').MetricsCollector | null {
    return this.#metrics
  }

  /** Initialise metrics and/or OTel collectors. Call once during gateway start(). */
  async init(opts: { enableMetrics?: boolean; enableOtel?: boolean }): Promise<void> {
    if (opts.enableMetrics) {
      const { MetricsCollector } = await import('@skelm/metrics')
      this.#metrics = new MetricsCollector()
    }
    if (opts.enableOtel) {
      // Captured behind a closure so the dynamic import only happens once
      // and per-run attach calls are synchronous (matches metrics).
      const { attachOpenTelemetry } = await import('@skelm/otel')
      this.#otelAttach = (bus) => attachOpenTelemetry(bus)
    }
  }

  /** Subscribe an EventBus into the metrics collector. No-op when disabled. */
  attachMetricsBus(bus: EventBus): void {
    if (this.#metrics === null) return
    this.#metrics.attach(bus)
  }

  /** Subscribe an EventBus into the OTel collector. No-op when disabled. */
  attachOtelBus(bus: EventBus): void {
    if (this.#otelAttach === null) return
    this.#otelDisposers.push(this.#otelAttach(bus))
  }

  /**
   * Unsubscribe all OTel attachments and clear all collectors.
   * Call during gateway stop() so spans stop being emitted and listener
   * references on freed buses are released.
   */
  dispose(): void {
    for (const disposer of this.#otelDisposers) {
      try {
        disposer.dispose()
      } catch {
        /* otel dispose failures must not block gateway stop */
      }
    }
    this.#otelDisposers = []
    this.#otelAttach = null
    this.#metrics = null
  }
}
