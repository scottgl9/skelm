// @skelm/package-publisher — validate, self-test-entry-check, secret-scan, and
// publish-dry-run skelm workflow packages. Library surface used by this
// package's own workflow entrypoints and by callers embedding the checks.

export {
  buildDryRun,
  buildPermissionSummary,
  runPublish,
  scanPackageForSecrets,
} from './publisher.js'
export type {
  DryRunFile,
  DryRunReport,
  PermissionSummary,
  PublishOptions,
  PublishReport,
  PublishStageStatus,
  PublishStages,
  SelfTestResult,
  WorkflowPermissionSummary,
} from './types.js'
export { redactSecret, scanText, SECRET_SCAN_RULES } from './secret-scan.js'
export type { SecretFinding } from './secret-scan.js'
