import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '@skelm/core'

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
          this.pending.delete(id)
          reject(new Error(`approval ${id} timed out after ${this.opts.timeoutMs}ms`))
        }, this.opts.timeoutMs)
        entry.timer.unref?.()
      }
      this.pending.set(id, entry)
      void this.persist()
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
    entry.resolve(decision)
    return true
  }

  /** Reject all pending approvals — used during gateway stop. */
  drain(reason = 'gateway stopping'): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(new Error(`approval ${id} cancelled: ${reason}`))
    }
    this.pending.clear()
    void this.persist()
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
