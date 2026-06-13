import type { SecretFinding } from './secret-scan.js'

/**
 * Per-workflow declared-capability summary. References only — permission
 * dimensions are reported as the *names/shapes* declared in the manifest, never
 * resolved against any secret store and never carrying a secret value.
 */
export interface WorkflowPermissionSummary {
  id: string
  entry: string
  kind: 'pipeline' | 'persistent'
  /** True when the workflow declares any `permissions` block at all. */
  hasPermissions: boolean
  /** Named executable profiles referenced (names only). */
  executableProfiles: readonly string[]
  /** Explicit allowed executables (names only). */
  allowedExecutables: readonly string[]
  /** True when a network-egress policy is declared. */
  declaresNetworkEgress: boolean
  /** Filesystem read/write roots declared (paths as written in the manifest). */
  fsRead: readonly string[]
  fsWrite: readonly string[]
  /** Secret NAMES this workflow's permissions allow (never values). */
  allowedSecrets: readonly string[]
  /** True when the workflow requests an unrestricted bypass (inert without operator grant). */
  requestsUnrestricted: boolean
}

/** Package-level permission summary: per-workflow plus manifest-declared references. */
export interface PermissionSummary {
  workflows: readonly WorkflowPermissionSummary[]
  /** Secret NAMES the manifest declares it needs (never values). */
  declaredSecrets: readonly string[]
  /** Integration ids the manifest declares. */
  integrations: readonly string[]
  /** Trigger ids/kinds the manifest offers (always disabled until an operator arms them). */
  triggers: readonly { id: string; kind: string }[]
  /** State namespaces the manifest declares it writes. */
  stateNamespaces: readonly string[]
}

/** One file that would be included in a publish, with its size. */
export interface DryRunFile {
  /** Package-relative posix path. */
  path: string
  bytes: number
}

/** What a publish WOULD ship. Assembled, never sent anywhere. */
export interface DryRunReport {
  name: string
  version: string
  /** `sha256:<hex>` content integrity over the package directory. */
  integrity: string
  files: readonly DryRunFile[]
  totalBytes: number
  /** Always false here: real npm publish is out of scope / operator-gated. */
  published: false
}

/** Outcome of validating the package's declared self-test entry. */
export interface SelfTestResult {
  status: 'passed' | 'failed' | 'skipped'
  /** Package-relative entry path, when one was declared. */
  entry?: string
  /** Failure detail when status is 'failed'. Never includes secret values. */
  detail?: string
}

export type PublishStageStatus = 'passed' | 'failed' | 'skipped'

/** Per-stage status, for a reviewable report and accurate exit gating. */
export interface PublishStages {
  validateManifest: PublishStageStatus
  permissionSummary: PublishStageStatus
  secretScan: PublishStageStatus
  selfTest: PublishStageStatus
  dryRun: PublishStageStatus
}

/** The full publish-pipeline report. `ok` is true only when no stage failed. */
export interface PublishReport {
  ok: boolean
  packageDir: string
  stages: PublishStages
  /** Present once the manifest validates. */
  name?: string
  version?: string
  /** Typed manifest error message when validation failed. */
  manifestError?: string
  permissions?: PermissionSummary
  /** Redacted secret findings. A non-empty list fails the run. */
  secretFindings: readonly SecretFinding[]
  selfTest: SelfTestResult
  dryRun?: DryRunReport
}

/** Options for {@link runPublish}. */
export interface PublishOptions {
  /** Validate the declared self-test entry. Default true. */
  runSelfTest?: boolean
  /**
   * Operator gate for an ACTUAL publish. This package never publishes; the flag
   * exists so a caller must opt in explicitly elsewhere. Setting it here only
   * records intent in the report and does NOT perform a publish.
   */
  allowPublish?: boolean
}
