import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { AuditEvent, AuditWriter, SecretResolver, SkelmConfigAuditSink } from '@skelm/core'

/**
 * SIEM / log-streaming forwarder for the audit log.
 *
 * This is a READ-SIDE tee over the single canonical {@link AuditWriter}, not a
 * second audit writer: it delegates every `write()` to the inner writer first,
 * and only after the canonical write resolves does it fan the same record out
 * to external sinks. Forwarding is best-effort — a sink that throws or times
 * out is logged and swallowed, never propagated, so it can neither break the
 * audit write nor poison the gateway loop.
 *
 * No secret value is forwarded: audit records carry names + non-secret
 * metadata only (the canonical writer enforces this), and a sink's own
 * credential is referenced by secret name and resolved gateway-side.
 */
export interface AuditSink {
  /** Forward one audit record. May reject; the forwarder isolates the failure. */
  forward(event: AuditEvent): Promise<void>
  close?(): Promise<void>
}

export class ForwardingAuditWriter implements AuditWriter {
  constructor(
    private readonly inner: AuditWriter,
    private readonly sinks: readonly AuditSink[],
    private readonly onError: (err: unknown, sink: AuditSink) => void = () => {},
  ) {}

  async write(event: AuditEvent): Promise<void> {
    // Canonical write first and unconditionally. Its result is authoritative.
    await this.inner.write(event)
    // Tee, isolated per-sink. We do not await the fan-out before returning so a
    // slow sink never adds latency to the privileged action being audited; we
    // do catch every rejection so a failing sink cannot surface as an
    // unhandled rejection in the gateway loop.
    for (const sink of this.sinks) {
      void sink.forward(event).catch((err: unknown) => this.onError(err, sink))
    }
  }

  async close(): Promise<void> {
    for (const sink of this.sinks) {
      if (sink.close !== undefined) {
        await sink.close().catch(() => {})
      }
    }
  }
}

/** Append-only JSON-Lines sink. The simplest durable forwarding target. */
export class FileAuditSink implements AuditSink {
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}

  forward(event: AuditEvent): Promise<void> {
    this.queue = this.queue.then(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true })
      await fs.appendFile(this.path, `${JSON.stringify(event)}\n`)
    })
    return this.queue
  }
}

/** Generic HTTP/webhook sink: POSTs each record as a JSON body. */
export class HttpAuditSink implements AuditSink {
  constructor(
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>>,
    private readonly timeoutMs: number,
  ) {}

  async forward(event: AuditEvent): Promise<void> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) {
      // Drain the body so the socket can be reused, then signal failure. The
      // status is non-secret; the response body is not surfaced.
      await res.text().catch(() => {})
      throw new Error(`audit sink POST ${this.url} failed: ${res.status}`)
    }
  }
}

/**
 * Build the configured sinks, resolving any `headerSecretName` through the
 * gateway's secret resolver. The resolved bearer value is held only inside the
 * sink closure; it never returns to config, logs, or audit.
 */
export async function buildAuditSinks(
  configs: readonly SkelmConfigAuditSink[],
  secrets: SecretResolver,
): Promise<AuditSink[]> {
  const sinks: AuditSink[] = []
  for (const cfg of configs) {
    if (cfg.kind === 'file') {
      sinks.push(new FileAuditSink(cfg.path))
      continue
    }
    const headers: Record<string, string> = { ...(cfg.headers ?? {}) }
    if (cfg.headerSecretName !== undefined) {
      const value = await secrets.resolve(cfg.headerSecretName)
      if (value !== undefined) headers.authorization = `Bearer ${value}`
    }
    sinks.push(new HttpAuditSink(cfg.url, headers, cfg.timeoutMs ?? 3000))
  }
  return sinks
}
