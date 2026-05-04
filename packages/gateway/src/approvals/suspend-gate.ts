import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '@skelm/core'

export interface PendingApproval {
  id: string
  request: ApprovalRequest
  createdAt: string
}

export interface SuspendApprovalGateOptions {
  /** Optional max wait per approval in milliseconds. Default: indefinite. */
  timeoutMs?: number
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
  }
}
