// Public types for the security auditor. A finding is the unit of output: it
// names the rule that fired, where, and a REDACTED human-readable detail. The
// auditor never carries a matched secret value into a finding — only the file
// and a redacted marker.

/** Severity of a finding, ordered low < medium < high. */
export type Severity = 'low' | 'medium' | 'high'

/** Stable identifier for each audit rule. */
export type RuleId =
  | 'fs-write-broad'
  | 'network-egress-broad'
  | 'unrestricted-grant'
  | 'secret-value-in-source'
  | 'risky-executable-profile'
  | 'missing-approval-privileged'
  | 'manifest-permission-drift'
  | 'unverified-webhook-trigger'

/** Where a finding was located. Every field is informational, never a secret. */
export interface FindingLocation {
  /** Workflow / pipeline id the finding belongs to, when known. */
  readonly workflowId?: string
  /** Step id the finding is attached to, when the finding is step-scoped. */
  readonly stepId?: string
  /** Source file the finding was found in, when known. */
  readonly file?: string
  /** 1-based line number within `file`, when the finding is line-scoped. */
  readonly line?: number
}

/** A single audit finding. `detail` is always redaction-safe. */
export interface Finding {
  readonly rule: RuleId
  readonly severity: Severity
  readonly title: string
  /** Redaction-safe explanation. NEVER contains a matched secret value. */
  readonly detail: string
  readonly location: FindingLocation
}

/** Structured result of an audit run. */
export interface AuditReport {
  /** Findings ordered high → low severity, then by rule id. */
  readonly findings: readonly Finding[]
  /** Count of findings at each severity. */
  readonly summary: { readonly high: number; readonly medium: number; readonly low: number }
  /** True when no finding is at or above the configured failure threshold. */
  readonly ok: boolean
}

/** Per-rule toggle and optional severity override. */
export interface RuleConfig {
  /** When false, the rule is skipped entirely. Defaults to true. */
  readonly enabled?: boolean
  /** Override the rule's default severity. */
  readonly severity?: Severity
}

/** Auditor configuration: rule toggles and the failure threshold. */
export interface AuditConfig {
  /** Per-rule overrides keyed by rule id. Omitted rules use their defaults. */
  readonly rules?: Partial<Record<RuleId, RuleConfig>>
  /**
   * Lowest severity that makes the report `ok: false`. Findings below it are
   * reported but do not fail the audit. Defaults to `high`.
   */
  readonly failOn?: Severity
}
