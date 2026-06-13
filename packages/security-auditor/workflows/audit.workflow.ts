// Entrypoint pipeline for @skelm/security-auditor. Given a loaded target
// workflow (and optionally its source text for the secret scan), it produces a
// structured AuditReport. The target is only INSPECTED — never executed — so
// auditing a workflow takes no permissions of its own.

import { code, pipeline } from '@skelm/core'
import type { AgentPermissions, Context, Pipeline } from '@skelm/core'
import { auditWorkflow } from '../src/audit.js'
import { resolveAuditConfig } from '../src/config.js'
import type { AuditConfig, AuditReport } from '../src/types.js'

/** Input to the audit pipeline: the workflow under audit plus optional context. */
export interface AuditPipelineInput {
  /** The loaded target workflow to inspect. Never executed. */
  workflow: Pipeline
  /** Raw source of the target workflow module, enabling the secret-value scan. */
  source?: string
  /** Path the target was loaded from, used for finding locations. */
  file?: string
  /** Manifest-declared permission ceiling for the target, for drift checks. */
  manifestPermissions?: AgentPermissions
  /** Rule toggles and failure threshold. */
  config?: AuditConfig
}

export default pipeline<AuditPipelineInput, AuditReport>({
  id: 'security-auditor',
  description: 'Static security audit of a workflow without executing it.',
  steps: [
    code<AuditReport>({
      id: 'audit',
      run: (ctx: Context<AuditPipelineInput>): AuditReport => {
        const { workflow, source, file, manifestPermissions, config } = ctx.input
        return auditWorkflow(
          {
            workflow,
            ...(source !== undefined && { source }),
            ...(file !== undefined && { file }),
            ...(manifestPermissions !== undefined && { manifestPermissions }),
          },
          resolveAuditConfig(config),
        )
      },
    }),
  ],
  finalize: (ctx) => ctx.steps.audit as AuditReport,
})
