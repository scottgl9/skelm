// Public surface of @skelm/workflow-debugger.

export { analyzeBundle, analyzeFailedRun } from './analyze.js'
export type { AnalyzeOptions } from './analyze.js'

export { GatewayDebugHttpClient } from './client.js'
export type { GatewayDebugHttpClientOptions } from './client.js'

export {
  parseWorkflowDebuggerConfig,
  WorkflowDebuggerConfigSchema,
} from './config.js'
export type {
  WorkflowDebuggerConfig,
  WorkflowDebuggerConfigInput,
} from './config.js'

export { redactString, redactToDetail, redactValue } from './redact.js'

export type {
  ArtifactSummary,
  AuditRow,
  DebugReport,
  Evidence,
  EvidenceKind,
  FailingStep,
  FixProposalDraft,
  FixProposalInput,
  FixProposalTurn,
  GatewayDebugClient,
  GraphEditPreview,
  RunBundle,
  SuggestedFix,
} from './types.js'
