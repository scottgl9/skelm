// @skelm/security-auditor — static security audit for skelm workflows and
// workflow packages. The auditor never executes the workflow under test: it
// reads structure from the derived WorkflowGraph and reads detailed permission
// values off the authored steps, and scans source text for embedded secret
// values (reporting only a redacted preview, never the value itself).

export { auditPackage, auditWorkflow } from './audit.js'
export type {
  AuditWorkflowInput,
  PackageWorkflowInput,
} from './audit.js'
export { ALL_RULE_IDS, DEFAULT_AUDIT_CONFIG, resolveAuditConfig } from './config.js'
export {
  executableBasename,
  isBroadFsRoot,
  isRiskyExecutable,
  isWildcardHost,
  redactSecret,
  scanSecrets,
} from './heuristics.js'
export type { SecretMatch } from './heuristics.js'
export type {
  AuditConfig,
  AuditReport,
  Finding,
  FindingLocation,
  RuleConfig,
  RuleId,
  Severity,
} from './types.js'
