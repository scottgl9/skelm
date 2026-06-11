/**
 * Approval gate owned by the gateway.
 *
 * When a step declares `permissions.approval`, the runtime calls the gate
 * to determine whether the action proceeds. Implementations may resolve
 * synchronously (auto-approve / auto-deny in tests) or suspend the run
 * indefinitely until a human responds.
 *
 * Synchronous defaults support tests and in-process runs. The gateway suspend
 * implementation is backed by RunStore and the HTTP control surface.
 */
export interface ApprovalRequest {
  runId: string
  stepId: string
  /** What is being requested (e.g. 'tool.exec', 'fs.write'). */
  action: string
  /** Free-form structured context the approver sees. */
  context: Readonly<Record<string, unknown>>
}

export interface ApprovalDecision {
  approved: boolean
  approver?: string
  reason?: string
}

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<ApprovalDecision>
}

export class AutoApproveGate implements ApprovalGate {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return { approved: true, approver: 'auto' }
  }
}

export class AutoDenyGate implements ApprovalGate {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return { approved: false, approver: 'auto', reason: 'auto-deny' }
  }
}
