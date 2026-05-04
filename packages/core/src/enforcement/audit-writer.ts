/**
 * Audit writer interface owned by the gateway.
 *
 * Phase 4 introduces the seam; the in-process default is a no-op. Phase 5
 * supplies the file-backed append-only chain and exposes it via
 * `skelm audit query`.
 *
 * Audit writers MUST NOT log secret values — only the *fact* of access.
 */
export interface AuditEvent {
  /** ISO-8601 timestamp captured by the writer; the resolver may overwrite. */
  timestamp?: string
  runId?: string
  actor: string
  action: string
  /** Free-form structured metadata. Never include secret values here. */
  details?: Readonly<Record<string, unknown>>
}

export interface AuditWriter {
  write(entry: AuditEvent): Promise<void>
}

/**
 * Default writer used when no explicit gateway-owned writer is supplied
 * (unit tests, isolated `runPipeline()` calls). Drops every entry on the
 * floor; production runs always go through the gateway's chain writer.
 */
export class NoopAuditWriter implements AuditWriter {
  async write(_entry: AuditEvent): Promise<void> {
    // intentionally empty
  }
}
