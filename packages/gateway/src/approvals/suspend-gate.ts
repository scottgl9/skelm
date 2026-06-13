import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { ApprovalDecision, ApprovalGate, ApprovalRequest, AuditWriter } from '@skelm/core'

export interface PendingApproval {
  id: string
  request: ApprovalRequest
  createdAt: string
}

export interface SuspendApprovalGateOptions {
  /** Optional max wait per approval in milliseconds. Default: indefinite. */
  timeoutMs?: number
  /**
   * Optional path to write a JSON snapshot of the pending queue to on every
   * change. Lets the CLI's `skelm approvals list` reflect live state without
   * touching the gateway HTTP surface, and is reloaded on the next gateway
   * boot via {@link SuspendApprovalGate.load} so an approval parked across a
   * restart survives and is still resolvable. The snapshot is request-only (no
   * promise resolvers); resolving a reloaded entry requires the running gateway.
   */
  persistPath?: string
  /**
   * Gateway audit writer. When supplied, each approval lifecycle transition
   * (requested, resolved, expired) is recorded so decisions survive gateway
   * restart and are tamper-evident under the chain writer.
   */
  auditWriter?: AuditWriter
}

interface GateEntry {
  request: ApprovalRequest
  createdAt: string
  // Resolvers are absent for entries rehydrated from the snapshot on boot:
  // the run process that issued request() died with the previous gateway, so
  // there is no in-memory promise left to settle. A reloaded entry is still
  // listed and still resolvable via approve()/deny() — the decision is
  // recorded to audit and removed from the durable snapshot.
  resolve?: ((decision: ApprovalDecision) => void) | undefined
  reject?: ((err: Error) => void) | undefined
  timer?: NodeJS.Timeout | undefined
}

/**
 * Suspend gate. Each in-process `request()` returns a pending promise that
 * resolves only when `resolve()`/`deny()` is called from the HTTP control
 * surface or the CLI. The pending queue is persisted to `persistPath` on every
 * change and reloaded on boot via {@link load}, so a parked approval survives a
 * real gateway restart and stays resolvable afterwards.
 */
export class SuspendApprovalGate implements ApprovalGate {
  private pending: Map<string, GateEntry> = new Map()
  private persistChain: Promise<void> = Promise.resolve()
  private auditChain: Promise<void> = Promise.resolve()

  constructor(private readonly opts: SuspendApprovalGateOptions = {}) {}

  list(): PendingApproval[] {
    return Array.from(this.pending.entries()).map(([id, p]) => ({
      id,
      request: p.request,
      createdAt: p.createdAt,
    }))
  }

  /**
   * Rehydrate the pending queue from the persisted snapshot. Called once on
   * gateway boot before the HTTP surface comes up, so approvals parked across a
   * restart reappear in `list()` and remain resolvable via approve()/deny().
   * Entries already present (issued in this process) are never overwritten.
   */
  async load(): Promise<void> {
    const persistPath = this.opts.persistPath
    if (persistPath === undefined) return
    let raw: string
    try {
      raw = await fs.readFile(persistPath, 'utf8')
    } catch {
      return
    }
    let snapshot: unknown
    try {
      snapshot = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(snapshot)) return
    for (const item of snapshot) {
      if (item === null || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const id = typeof rec.id === 'string' ? rec.id : undefined
      const runId = typeof rec.runId === 'string' ? rec.runId : undefined
      const stepId = typeof rec.stepId === 'string' ? rec.stepId : undefined
      const action = typeof rec.action === 'string' ? rec.action : undefined
      const createdAt = typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString()
      if (id === undefined || runId === undefined || stepId === undefined || action === undefined) {
        continue
      }
      if (this.pending.has(id)) continue
      const context =
        rec.context !== null && typeof rec.context === 'object'
          ? Object.freeze({ ...(rec.context as Record<string, unknown>) })
          : Object.freeze({})
      this.pending.set(id, {
        request: { runId, stepId, action, context },
        createdAt,
      })
    }
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const id = `${req.runId}:${req.stepId}`
    const existing = this.pending.get(id)
    if (existing !== undefined) {
      // A reloaded entry (no resolvers) is the same logical approval being
      // re-requested after restart — adopt this process's resolvers rather
      // than rejecting it as a duplicate, so the run can be resolved live.
      if (existing.resolve !== undefined) {
        throw new Error(`approval ${id} already pending`)
      }
      return new Promise<ApprovalDecision>((resolve, reject) => {
        existing.resolve = resolve
        existing.reject = reject
      })
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const entry: GateEntry = {
        request: req,
        createdAt: new Date().toISOString(),
        resolve,
        reject,
      }
      if (this.opts.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          // Plan §4.2: await the audit write before the run observes the
          // timeout, so a crash between reject() and the audit flush
          // can't leave a decision off the durable record. The same
          // pattern is applied to the deliver() path.
          this.pending.delete(id)
          void this.persist()
          void this.audit({
            runId: req.runId,
            actor: 'gateway',
            action: 'approval.expired',
            details: {
              approvalId: id,
              stepId: req.stepId,
              requestedAction: req.action,
              timeoutMs: this.opts.timeoutMs,
            },
          }).finally(() => {
            reject(new Error(`approval ${id} timed out after ${this.opts.timeoutMs}ms`))
          })
        }, this.opts.timeoutMs)
        entry.timer.unref?.()
      }
      this.pending.set(id, entry)
      void this.persist()
      void this.audit({
        runId: req.runId,
        actor: 'gateway',
        action: 'approval.requested',
        details: {
          approvalId: id,
          stepId: req.stepId,
          requestedAction: req.action,
          context: req.context,
        },
      })
    })
  }

  approve(id: string, approver?: string, reason?: string): boolean {
    return this.deliver(id, {
      approved: true,
      ...(approver && { approver }),
      ...(reason && { reason }),
    })
  }

  deny(id: string, approver?: string, reason?: string): boolean {
    return this.deliver(id, {
      approved: false,
      ...(approver && { approver }),
      ...(reason && { reason }),
    })
  }

  private deliver(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.pending.delete(id)
    void this.persist()
    // Plan §4.2: chain the resolve() onto audit completion so the durable
    // decision row is flushed before any downstream step observes the
    // approval. Without this, a crash between resolve() and the audit
    // write completing would lose the row — forensics would see
    // 'approval.requested' with no matching 'approval.resolved' and an
    // operator couldn't tell whether the approval ever happened.
    void this.audit({
      runId: entry.request.runId,
      actor: decision.approver ?? 'unknown',
      action: 'approval.resolved',
      details: {
        approvalId: id,
        stepId: entry.request.stepId,
        requestedAction: entry.request.action,
        approved: decision.approved,
        ...(decision.reason !== undefined && { reason: decision.reason }),
      },
    }).finally(() => {
      // A reloaded entry has no live promise (the run died with the previous
      // gateway); the durable audit + snapshot removal above is the decision
      // record. Live entries settle their run's request() promise here.
      entry.resolve?.(decision)
    })
    return true
  }

  /**
   * Persist the pending queue and detach in-memory promises during gateway
   * stop. Pending approvals are NOT rejected: the snapshot is kept so they
   * survive the restart and reload via {@link load}, still resolvable
   * afterwards. The in-memory promises are settled cleanly by dropping their
   * resolvers — the run process is exiting with the gateway, so a reject()
   * here would only surface as an unhandled rejection while destroying a
   * still-valid pending approval.
   */
  async drain(_reason = 'gateway stopping'): Promise<void> {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.timer = undefined
      entry.resolve = undefined
      entry.reject = undefined
    }
    await this.persist()
  }

  private async audit(event: {
    runId: string
    actor: string
    action: string
    details: Readonly<Record<string, unknown>>
  }): Promise<void> {
    if (this.opts.auditWriter === undefined) return Promise.resolve()
    const write = async () => {
      try {
        await this.opts.auditWriter?.write(event)
      } catch (err) {
        // Audit failures must not affect approval flow, but they must not vanish
        // either — an approval decision dropping out of the durable record is a
        // forensic gap. Surface it instead of swallowing silently.
        const detail = err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `[skelm audit] approval write failed (action=${event.action} run=${event.runId}): ${detail}\n`,
        )
      }
    }
    this.auditChain = this.auditChain.then(write, write)
    return this.auditChain
  }

  private async persist(): Promise<void> {
    const persistPath = this.opts.persistPath
    if (persistPath === undefined) return Promise.resolve()
    const write = async () => {
      try {
        await fs.mkdir(dirname(persistPath), { recursive: true })
        const snapshot = Array.from(this.pending.entries()).map(([id, p]) => ({
          id,
          runId: p.request.runId,
          stepId: p.request.stepId,
          action: p.request.action,
          context: p.request.context,
          createdAt: p.createdAt,
        }))
        await fs.writeFile(persistPath, JSON.stringify(snapshot, null, 2))
      } catch {
        // Best-effort — chain audit captures the request itself.
      }
    }
    this.persistChain = this.persistChain.then(write, write)
    return this.persistChain
  }
}
