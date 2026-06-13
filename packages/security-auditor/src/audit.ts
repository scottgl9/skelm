// The audit engine. It inspects a workflow WITHOUT executing it: structure
// comes from `deriveWorkflowGraph` (nodes/children/codeOwned), and the detailed
// permission values come from walking the authored `Pipeline.steps` directly —
// the graph's permission summary is deliberately redacted (no hosts/paths/
// executables), so detail rules read the raw `AgentPermissions` off the steps.

import { deriveWorkflowGraph } from '@skelm/core'
import type {
  AgentPermissions,
  ApprovalPolicy,
  NetworkPolicy,
  PermissionDimension,
  Pipeline,
  PipelineTrigger,
  Step,
  WorkflowPackageManifest,
} from '@skelm/core'
import {
  executableBasename,
  isBroadFsRoot,
  isRiskyExecutable,
  isWildcardHost,
  scanSecrets,
} from './heuristics.js'
import type { AuditConfig, AuditReport, Finding, RuleConfig, RuleId, Severity } from './types.js'

const DEFAULT_SEVERITY: Record<RuleId, Severity> = {
  'fs-write-broad': 'high',
  'network-egress-broad': 'high',
  'unrestricted-grant': 'high',
  'secret-value-in-source': 'high',
  'risky-executable-profile': 'high',
  'missing-approval-privileged': 'medium',
  'manifest-permission-drift': 'medium',
  'unverified-webhook-trigger': 'medium',
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 }

// Privileged dimensions whose use without an approval gate is worth flagging.
const PRIVILEGED_DIMENSIONS: readonly PermissionDimension[] = [
  'executable',
  'network',
  'fs.write',
  'secret',
  'mcp',
]

/** A workflow plus the source text it was loaded from, for source-level rules. */
export interface AuditWorkflowInput {
  readonly workflow: Pipeline
  /** Raw source of the workflow module, when available, for secret scanning. */
  readonly source?: string
  /** File path the workflow/source came from, for finding locations. */
  readonly file?: string
  /** Manifest-declared permission ceiling for this workflow, for drift checks. */
  readonly manifestPermissions?: AgentPermissions
}

interface RuleContext {
  readonly config: AuditConfig
  readonly findings: Finding[]
}

function ruleConfigFor(config: AuditConfig, rule: RuleId): RuleConfig {
  return config.rules?.[rule] ?? {}
}

function severityFor(config: AuditConfig, rule: RuleId): Severity {
  return ruleConfigFor(config, rule).severity ?? DEFAULT_SEVERITY[rule]
}

function ruleEnabled(config: AuditConfig, rule: RuleId): boolean {
  return ruleConfigFor(config, rule).enabled !== false
}

function emit(
  ctx: RuleContext,
  rule: RuleId,
  override: Severity | undefined,
  title: string,
  detail: string,
  location: Finding['location'],
): void {
  if (!ruleEnabled(ctx.config, rule)) return
  ctx.findings.push({
    rule,
    severity: override ?? severityFor(ctx.config, rule),
    title,
    detail,
    location,
  })
}

/** Flatten a pipeline's steps, descending into the nested control-flow shapes. */
function flattenSteps(steps: readonly Step[]): Step[] {
  const out: Step[] = []
  const visit = (step: Step): void => {
    out.push(step)
    switch (step.kind) {
      case 'parallel':
        for (const s of step.steps) visit(s)
        break
      case 'branch':
        for (const s of Object.values(step.cases)) visit(s as Step)
        if (step.default !== undefined) visit(step.default)
        break
      case 'loop':
        visit(step.step)
        break
      case 'idempotent':
        visit(step.step)
        break
      case 'pipelineStep':
        for (const s of step.pipeline.steps) visit(s)
        break
    }
  }
  for (const s of steps) visit(s)
  return out
}

function permissionsOf(step: Step): AgentPermissions | undefined {
  return (step as { permissions?: AgentPermissions }).permissions
}

function approvalGates(approval: ApprovalPolicy | undefined, dim: PermissionDimension): boolean {
  return approval?.on.includes(dim) === true
}

function networkBreadth(policy: NetworkPolicy): 'allow' | 'wildcard' | 'scoped' {
  if (policy === 'allow') return 'allow'
  if (policy === 'deny') return 'scoped'
  if (policy.allowHosts.some(isWildcardHost)) return 'wildcard'
  return 'scoped'
}

function checkStepPermissions(ctx: RuleContext, workflowId: string, step: Step): void {
  const perms = permissionsOf(step)
  if (perms === undefined) return
  const location = { workflowId, stepId: step.id }

  if (perms.requestUnrestricted === true) {
    emit(
      ctx,
      'unrestricted-grant',
      undefined,
      'Step requests an unrestricted permission bypass',
      `step "${step.id}" sets requestUnrestricted; if the operator grants this workflow, every permission dimension is bypassed`,
      location,
    )
  }

  for (const root of perms.fsWrite ?? []) {
    if (isBroadFsRoot(root)) {
      emit(
        ctx,
        'fs-write-broad',
        undefined,
        'Overly broad filesystem write root',
        `step "${step.id}" declares fsWrite root "${root}", which grants write access to the project root or filesystem root`,
        location,
      )
    }
  }

  if (perms.networkEgress !== undefined) {
    const breadth = networkBreadth(perms.networkEgress)
    if (breadth === 'allow') {
      emit(
        ctx,
        'network-egress-broad',
        undefined,
        'Unrestricted network egress',
        `step "${step.id}" sets networkEgress to "allow", permitting egress to any host`,
        location,
      )
    } else if (breadth === 'wildcard') {
      emit(
        ctx,
        'network-egress-broad',
        'medium',
        'Wildcard network egress host',
        `step "${step.id}" allows a wildcard egress host, broadening the permitted destination set`,
        location,
      )
    }
  }

  for (const exe of perms.allowedExecutables ?? []) {
    if (isRiskyExecutable(exe)) {
      emit(
        ctx,
        'risky-executable-profile',
        undefined,
        'High-risk executable allowed',
        `step "${step.id}" allows executable "${executableBasename(exe)}" (shell / package-manager / cloud-CLI class)`,
        location,
      )
    }
  }
  for (const profile of perms.executableProfiles ?? []) {
    if (isRiskyExecutable(profile)) {
      emit(
        ctx,
        'risky-executable-profile',
        undefined,
        'High-risk executable profile referenced',
        `step "${step.id}" references executable profile "${profile}" whose name matches a high-risk command class`,
        location,
      )
    }
  }

  for (const dim of PRIVILEGED_DIMENSIONS) {
    if (stepDeclaresDimension(perms, dim) && !approvalGates(perms.approval, dim)) {
      emit(
        ctx,
        'missing-approval-privileged',
        undefined,
        'Privileged step has no approval gate',
        `step "${step.id}" grants the privileged "${dim}" dimension without an approval policy gating it`,
        location,
      )
    }
  }
}

function stepDeclaresDimension(perms: AgentPermissions, dim: PermissionDimension): boolean {
  switch (dim) {
    case 'executable':
      return (
        (perms.allowedExecutables?.length ?? 0) > 0 || (perms.executableProfiles?.length ?? 0) > 0
      )
    case 'network':
      return perms.networkEgress !== undefined && perms.networkEgress !== 'deny'
    case 'fs.write':
      return (perms.fsWrite?.length ?? 0) > 0
    case 'secret':
      return (perms.allowedSecrets?.length ?? 0) > 0
    case 'mcp':
      return (perms.allowedMcpServers?.length ?? 0) > 0
    default:
      return false
  }
}

function checkSecrets(ctx: RuleContext, input: AuditWorkflowInput): void {
  if (input.source === undefined) return
  for (const match of scanSecrets(input.source)) {
    emit(
      ctx,
      'secret-value-in-source',
      undefined,
      'Secret value found in source',
      `a ${match.kind} value appears in source (redacted: ${match.redacted}); use a secret reference instead of an inline value`,
      {
        workflowId: input.workflow.id,
        ...(input.file !== undefined && { file: input.file }),
        line: match.line,
      },
    )
  }
}

function checkTriggers(
  ctx: RuleContext,
  workflowId: string,
  triggers: readonly PipelineTrigger[],
): void {
  for (const trigger of triggers) {
    if (trigger.kind !== 'webhook') continue
    const verified =
      (typeof trigger.secret === 'string' && trigger.secret.length > 0) ||
      trigger.provider !== undefined ||
      (typeof trigger.clientState === 'string' && trigger.clientState.length > 0)
    if (!verified) {
      emit(
        ctx,
        'unverified-webhook-trigger',
        undefined,
        'Webhook trigger has no verification',
        `webhook trigger on path "${trigger.path}" declares no signing secret, provider, or clientState; deliveries cannot be authenticated`,
        { workflowId },
      )
    }
  }
}

// Dimensions a step actually exercises, derived from its declared permissions.
function usedDimensions(steps: readonly Step[]): Set<PermissionDimension> {
  const used = new Set<PermissionDimension>()
  for (const step of steps) {
    const perms = permissionsOf(step)
    if (perms === undefined) continue
    for (const dim of PRIVILEGED_DIMENSIONS) {
      if (stepDeclaresDimension(perms, dim)) used.add(dim)
    }
  }
  return used
}

// Dimensions the manifest ceiling declares. Used to flag drift between what a
// package advertises it needs and what its workflows actually exercise.
function declaredDimensions(perms: AgentPermissions): Set<PermissionDimension> {
  const declared = new Set<PermissionDimension>()
  for (const dim of PRIVILEGED_DIMENSIONS) {
    if (stepDeclaresDimension(perms, dim)) declared.add(dim)
  }
  return declared
}

function checkManifestDrift(
  ctx: RuleContext,
  input: AuditWorkflowInput,
  steps: readonly Step[],
): void {
  if (input.manifestPermissions === undefined) return
  const declared = declaredDimensions(input.manifestPermissions)
  const used = usedDimensions(steps)
  for (const dim of declared) {
    if (!used.has(dim)) {
      emit(
        ctx,
        'manifest-permission-drift',
        undefined,
        'Manifest declares a permission the workflow never uses',
        `manifest grants the "${dim}" dimension as a ceiling, but no step in workflow "${input.workflow.id}" exercises it — tighten the declared ceiling`,
        {
          workflowId: input.workflow.id,
          ...(input.file !== undefined && { file: input.file }),
        },
      )
    }
  }
  for (const dim of used) {
    if (!declared.has(dim)) {
      emit(
        ctx,
        'manifest-permission-drift',
        undefined,
        'Workflow uses a permission the manifest never declares',
        `workflow "${input.workflow.id}" exercises the "${dim}" dimension, but the manifest ceiling never declares it — expand the declared ceiling or tighten the workflow`,
        {
          workflowId: input.workflow.id,
          ...(input.file !== undefined && { file: input.file }),
        },
      )
    }
  }
}

function buildReport(findings: readonly Finding[], failOn: Severity): AuditReport {
  const sorted = [...findings].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    return sev !== 0 ? sev : a.rule.localeCompare(b.rule)
  })
  const summary = { high: 0, medium: 0, low: 0 }
  for (const f of sorted) summary[f.severity] += 1
  const threshold = SEVERITY_RANK[failOn]
  const ok = sorted.every((f) => SEVERITY_RANK[f.severity] < threshold)
  return { findings: sorted, summary, ok }
}

/**
 * Audit a single workflow without executing it. Combines structural inspection
 * (via {@link deriveWorkflowGraph}) with detail rules read from the authored
 * step permissions, plus an optional source scan for embedded secret values.
 */
export function auditWorkflow(input: AuditWorkflowInput, config: AuditConfig = {}): AuditReport {
  const ctx: RuleContext = { config, findings: [] }
  // Derive the graph to confirm the workflow is well-formed and inspectable
  // without running it; structure also bounds what we walk below.
  deriveWorkflowGraph(input.workflow)
  const steps = flattenSteps(input.workflow.steps)
  for (const step of steps) checkStepPermissions(ctx, input.workflow.id, step)
  checkSecrets(ctx, input)
  checkTriggers(ctx, input.workflow.id, input.workflow.triggers ?? [])
  checkManifestDrift(ctx, input, steps)
  return buildReport(ctx.findings, config.failOn ?? 'high')
}

/** One workflow within a package audit, paired with its loaded source. */
export interface PackageWorkflowInput {
  readonly workflow: Pipeline
  readonly source?: string
  readonly file?: string
  /** Manifest-declared permission ceiling for this workflow entry. */
  readonly manifestPermissions?: AgentPermissions
}

/**
 * Audit a whole workflow package: every workflow entry is audited and the
 * findings are merged into one report. The manifest is consulted for per-entry
 * permission ceilings so drift can be detected against each workflow's actual
 * use.
 */
export function auditPackage(
  manifest: WorkflowPackageManifest,
  workflows: readonly PackageWorkflowInput[],
  config: AuditConfig = {},
): AuditReport {
  const ctx: RuleContext = { config, findings: [] }
  // Fall back to the manifest's per-workflow permission ceiling (matched by id)
  // when the caller didn't pass one explicitly, so drift is checked against the
  // declared ceiling even for callers that only supply loaded workflows.
  const manifestPermsById = new Map<string, AgentPermissions>()
  for (const wf of manifest.skelm.workflows) {
    if (wf.permissions !== undefined) manifestPermsById.set(wf.id, wf.permissions)
  }
  for (const entry of workflows) {
    const manifestPermissions =
      entry.manifestPermissions ?? manifestPermsById.get(entry.workflow.id)
    const single = auditWorkflow(
      {
        workflow: entry.workflow,
        ...(entry.source !== undefined && { source: entry.source }),
        ...(entry.file !== undefined && { file: entry.file }),
        ...(manifestPermissions !== undefined && { manifestPermissions }),
      },
      config,
    )
    ctx.findings.push(...single.findings)
  }
  return buildReport(ctx.findings, config.failOn ?? 'high')
}
