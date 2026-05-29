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
   * touching the gateway HTTP surface. The snapshot is request-only (no
   * promise resolvers); resuming requires the running gateway.
   */
  persistPath?: string
  /**
   * Gateway audit writer. When supplied, each approval lifecycle transition
   * (requested, resolved, expired, cancelled) is recorded so decisions
   * survive gateway restart and are tamper-evident under the chain writer.
   */
  auditWriter?: AuditWriter
}

/**
 * In-memory suspend gate. Each `request()` returns a pending promise that
 * resolves only when `resolve()` is called from the HTTP control surface or
 * the CLI. Persistence across gateway restarts (RunStore-backed) lands
 * alongside the approvals HTTP endpoint integration; the in-memory gate
 * is sufficient for the same-process lifetime.
 */
export class SuspendApprovalGate implements ApprovalGate {
  private pending: Map<
    string,
    {
      request: ApprovalRequest
      createdAt: string
      resolve: (decision: ApprovalDecision) => void
      reject: (err: Error) => void
      timer?: NodeJS.Timeout
    }
  > = new Map()

  constructor(private readonly opts: SuspendApprovalGateOptions = {}) {}

  list(): PendingApproval[] {
    return Array.from(this.pending.entries()).map(([id, p]) => ({
      id,
      request: p.request,
      createdAt: p.createdAt,
    }))
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const id = `${req.runId}:${req.stepId}`
    if (this.pending.has(id)) {
      throw new Error(`approval ${id} already pending`)
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const entry = {
        request: req,
        createdAt: new Date().toISOString(),
        resolve,
        reject,
      } as {
        request: ApprovalRequest
        createdAt: string
        resolve: (decision: ApprovalDecision) => void
        reject: (err: Error) => void
        timer?: NodeJS.Timeout
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
      entry.resolve(decision)
    })
    return true
  }

  /** Reject all pending approvals — used during gateway stop. */
  drain(reason = 'gateway stopping'): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      // Same audit-then-reject ordering as deliver()/timeout: ensure the
      // 'approval.cancelled' row hits disk before the awaiting promise
      // is settled, so a fast crash during drain still leaves a complete
      // forensic record for the operator.
      void this.audit({
        runId: entry.request.runId,
        actor: 'gateway',
        action: 'approval.cancelled',
        details: {
          approvalId: id,
          stepId: entry.request.stepId,
          requestedAction: entry.request.action,
          reason,
        },
      }).finally(() => {
        entry.reject(new Error(`approval ${id} cancelled: ${reason}`))
      })
    }
    this.pending.clear()
    void this.persist()
  }

  private async audit(event: {
    runId: string
    actor: string
    action: string
    details: Readonly<Record<string, unknown>>
  }): Promise<void> {
    if (this.opts.auditWriter === undefined) return
    try {
      await this.opts.auditWriter.write(event)
    } catch {
      // Audit failures must not affect approval flow; ChainAuditWriter is
      // best-effort from the gate's perspective.
    }
  }

  private async persist(): Promise<void> {
    if (this.opts.persistPath === undefined) return
    try {
      await fs.mkdir(dirname(this.opts.persistPath), { recursive: true })
      const snapshot = this.list().map((p) => ({
        id: p.id,
        runId: p.request.runId,
        stepId: p.request.stepId,
        action: p.request.action,
        createdAt: p.createdAt,
      }))
      await fs.writeFile(this.opts.persistPath, JSON.stringify(snapshot, null, 2))
    } catch {
      // Best-effort — chain audit captures the request itself.
    }
  }
}
