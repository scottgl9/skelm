import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { EXIT } from './exit-codes.js'
import type { MainIO, MainResult } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'

/**
 * Approval-policy management. The policy file is the source of truth for
 * which step kinds require approval, who the approvers are, and the default
 * timeout. The gateway re-reads it on `skelm gateway reload`.
 *
 * v1 scope is local-file mutation. Auditing the writes through the gateway
 * (so policy changes appear in the audit chain) is a follow-up — the issue
 * tracks that under "All writes route through the gateway".
 */

const KNOWN_STEP_KINDS = new Set([
  'agent',
  'llm',
  'code',
  'parallel',
  'forEach',
  'branch',
  'loop',
  'wait',
  'pipelineStep',
  'idempotent',
])

export interface ApprovalsConfigArgs {
  action: 'show' | 'validate' | 'set' | 'approvers-add' | 'approvers-remove'
  /** For `set <key> <value>` */
  key?: string
  value?: string
  /** For approvers-add / approvers-remove */
  approverId?: string
  json?: boolean
}

export interface ApprovalPolicy {
  /** Default wait timeout when an approval is requested without one. */
  defaultTimeoutMs?: number
  /** Step kinds that always require approval before running. */
  stepKindsRequiringApproval?: string[]
  /** Approver registry. */
  approvers?: Array<{ id: string; email?: string; channel?: string }>
}

export async function approvalsConfigCommand(
  args: ApprovalsConfigArgs,
  io: MainIO,
): Promise<MainResult> {
  const path = resolveConfigPath()
  try {
    switch (args.action) {
      case 'show':
        return await showPolicy(path, args, io)
      case 'validate':
        return await validatePolicy(path, args, io)
      case 'set':
        return await setKey(path, args, io)
      case 'approvers-add':
        return await mutateApprovers(path, args, 'add', io)
      case 'approvers-remove':
        return await mutateApprovers(path, args, 'remove', io)
      default: {
        const exhaustive: never = args.action
        io.stderr.write(`internal: unhandled approvals-config action ${exhaustive as string}\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
    }
  } catch (err) {
    io.stderr.write(`approvals config: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
}

function resolveConfigPath(): string {
  if (process.env.SKELM_APPROVALS_CONFIG) return process.env.SKELM_APPROVALS_CONFIG
  const stateDir = process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
  return join(stateDir, 'approvals.config.json')
}

async function readPolicy(path: string): Promise<ApprovalPolicy> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return assertApprovalPolicy(parsed)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

/**
 * Defensive shape check on a parsed policy file. The CLI is the only
 * writer in v1 but hand-edited or corrupted files used to be silently
 * spread back over the in-memory shape; this catches the obvious
 * misshapes (top-level non-object, wrong-typed scalar fields, approvers
 * array containing non-objects or missing `id`) before they corrupt
 * downstream writes.
 */
function assertApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('approvals config: top-level value must be a JSON object')
  }
  const p = value as Record<string, unknown>
  const out: ApprovalPolicy = {}
  if (p.defaultTimeoutMs !== undefined) {
    if (typeof p.defaultTimeoutMs !== 'number' || !Number.isFinite(p.defaultTimeoutMs)) {
      throw new Error("approvals config: 'defaultTimeoutMs' must be a finite number")
    }
    out.defaultTimeoutMs = p.defaultTimeoutMs
  }
  if (p.stepKindsRequiringApproval !== undefined) {
    if (
      !Array.isArray(p.stepKindsRequiringApproval) ||
      !p.stepKindsRequiringApproval.every((k): k is string => typeof k === 'string')
    ) {
      throw new Error("approvals config: 'stepKindsRequiringApproval' must be an array of strings")
    }
    out.stepKindsRequiringApproval = p.stepKindsRequiringApproval
  }
  if (p.approvers !== undefined) {
    if (!Array.isArray(p.approvers)) {
      throw new Error("approvals config: 'approvers' must be an array")
    }
    const approvers: ApprovalPolicy['approvers'] = []
    for (const [i, entry] of p.approvers.entries()) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`approvals config: approvers[${i}] must be an object`)
      }
      const a = entry as Record<string, unknown>
      if (typeof a.id !== 'string' || a.id.length === 0) {
        throw new Error(`approvals config: approvers[${i}].id must be a non-empty string`)
      }
      const rec: { id: string; email?: string; channel?: string } = { id: a.id }
      if (a.email !== undefined) {
        if (typeof a.email !== 'string') {
          throw new Error(`approvals config: approvers[${i}].email must be a string`)
        }
        rec.email = a.email
      }
      if (a.channel !== undefined) {
        if (typeof a.channel !== 'string') {
          throw new Error(`approvals config: approvers[${i}].channel must be a string`)
        }
        rec.channel = a.channel
      }
      approvers.push(rec)
    }
    out.approvers = approvers
  }
  return out
}

async function writePolicy(path: string, policy: ApprovalPolicy): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  // Atomic-ish: write a tmp file then rename. Prevents corruption on crash.
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, path)
}

async function showPolicy(
  path: string,
  args: ApprovalsConfigArgs,
  io: MainIO,
): Promise<MainResult> {
  const policy = await readPolicy(path)
  if (args.json) {
    writeJsonOutput(io, policy)
    return { exitCode: EXIT.OK }
  }
  io.stdout.write(`policy file: ${path}\n`)
  io.stdout.write(`defaultTimeoutMs: ${policy.defaultTimeoutMs ?? '(unset)'}\n`)
  io.stdout.write(
    `stepKindsRequiringApproval: ${(policy.stepKindsRequiringApproval ?? []).join(', ') || '(none)'}\n`,
  )
  io.stdout.write(`approvers (${(policy.approvers ?? []).length}):\n`)
  for (const a of policy.approvers ?? []) {
    io.stdout.write(
      `  - ${a.id}${a.email ? ` <${a.email}>` : ''}${a.channel ? ` @${a.channel}` : ''}\n`,
    )
  }
  return { exitCode: EXIT.OK }
}

async function validatePolicy(
  path: string,
  args: ApprovalsConfigArgs,
  io: MainIO,
): Promise<MainResult> {
  const issues = await collectIssues(path)
  if (args.json) {
    writeJsonOutput(io, { ok: issues.length === 0, issues })
  } else if (issues.length === 0) {
    io.stdout.write(`ok: ${path} validates\n`)
  } else {
    io.stderr.write(`error: ${issues.length} issue(s) in ${path}\n`)
    for (const i of issues) io.stderr.write(`  [${i.code}] ${i.at}: ${i.message}\n`)
  }
  return { exitCode: issues.length === 0 ? EXIT.OK : EXIT.CLI_ERROR }
}

async function collectIssues(
  path: string,
): Promise<Array<{ at: string; code: string; message: string }>> {
  const issues: Array<{ at: string; code: string; message: string }> = []
  let policy: ApprovalPolicy = {}
  try {
    const raw = await fs.readFile(path, 'utf8')
    try {
      policy = JSON.parse(raw)
    } catch (err) {
      issues.push({ at: path, code: 'parse-error', message: (err as Error).message })
      return issues
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Missing file is allowed — defaults take over. Not an error.
      return issues
    }
    throw err
  }

  if (
    policy.defaultTimeoutMs !== undefined &&
    (!Number.isFinite(policy.defaultTimeoutMs) || policy.defaultTimeoutMs < 1)
  ) {
    issues.push({
      at: 'defaultTimeoutMs',
      code: 'bad-timeout',
      message: 'must be a positive integer in milliseconds',
    })
  }
  if (policy.stepKindsRequiringApproval) {
    for (let i = 0; i < policy.stepKindsRequiringApproval.length; i++) {
      const k = policy.stepKindsRequiringApproval[i]
      if (!k || !KNOWN_STEP_KINDS.has(k)) {
        issues.push({
          at: `stepKindsRequiringApproval[${i}]`,
          code: 'unknown-step-kind',
          message: `"${k}" is not a known step kind`,
        })
      }
    }
  }
  if (policy.approvers) {
    const seen = new Set<string>()
    for (let i = 0; i < policy.approvers.length; i++) {
      const a = policy.approvers[i]
      if (!a || !a.id) {
        issues.push({
          at: `approvers[${i}]`,
          code: 'approver-missing-id',
          message: 'approver entry must have an id',
        })
        continue
      }
      if (seen.has(a.id)) {
        issues.push({
          at: `approvers[${i}]`,
          code: 'approver-duplicate-id',
          message: `duplicate approver id "${a.id}"`,
        })
      }
      seen.add(a.id)
    }
  }
  return issues
}

async function setKey(path: string, args: ApprovalsConfigArgs, io: MainIO): Promise<MainResult> {
  if (!args.key) {
    io.stderr.write('error: skelm approvals config set requires <key> <value>\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (args.value === undefined) {
    io.stderr.write('error: skelm approvals config set <key> requires a value\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  const policy = await readPolicy(path)
  switch (args.key) {
    case 'defaultTimeoutMs': {
      const n = Number.parseInt(args.value, 10)
      if (!Number.isFinite(n) || n < 1) {
        io.stderr.write('error: defaultTimeoutMs must be a positive integer\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      policy.defaultTimeoutMs = n
      break
    }
    case 'stepKindsRequiringApproval': {
      const kinds = args.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const bad = kinds.filter((k) => !KNOWN_STEP_KINDS.has(k))
      if (bad.length > 0) {
        io.stderr.write(`error: unknown step kind(s): ${bad.join(', ')}\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
      policy.stepKindsRequiringApproval = kinds
      break
    }
    default:
      io.stderr.write(
        `error: unknown key "${args.key}" (supported: defaultTimeoutMs, stepKindsRequiringApproval)\n`,
      )
      return { exitCode: EXIT.CLI_ERROR }
  }
  await writePolicy(path, policy)
  io.stdout.write(`set ${args.key} -> ${args.value}\n`)
  return { exitCode: EXIT.OK }
}

async function mutateApprovers(
  path: string,
  args: ApprovalsConfigArgs,
  op: 'add' | 'remove',
  io: MainIO,
): Promise<MainResult> {
  if (!args.approverId) {
    io.stderr.write(`error: skelm approvals config approvers ${op} requires an id\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  const policy = await readPolicy(path)
  policy.approvers ??= []
  const existing = policy.approvers.findIndex((a) => a.id === args.approverId)
  if (op === 'add') {
    if (existing !== -1) {
      io.stderr.write(`error: approver "${args.approverId}" already present\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    policy.approvers.push({ id: args.approverId })
  } else {
    if (existing === -1) {
      io.stderr.write(`error: approver "${args.approverId}" not present\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    policy.approvers.splice(existing, 1)
  }
  await writePolicy(path, policy)
  io.stdout.write(`${op}ed approver ${args.approverId}\n`)
  return { exitCode: EXIT.OK }
}
