/**
 * OpenClaw-style bridge tools, each a thin typed mapping onto one (or a few)
 * gateway HTTP routes. The bridge owns NO execution, enforcement, or audit — it
 * forwards to the gateway and reshapes the response into an OpenClaw tool
 * result, preserving run/task/audit references end-to-end.
 *
 *   skelm_run             POST /pipelines/:id/run     (synchronous run)
 *   skelm_start           POST /v1/tasks              (detached, tracked task)
 *   skelm_status          GET  /runs/:id/events
 *                         GET  /v1/tasks/:id          (run- or task-keyed)
 *   skelm_cancel          DELETE /runs/:id  | POST /v1/tasks/:id/cancel
 *   skelm_audit           GET  /audit                 (query audit refs)
 *   skelm_workflow_search GET  /pipelines             (list/find workflows)
 */

import type { DeliveryTarget } from '@skelm/core'
import type { GatewayHttpClient, GatewayResponse } from './client.js'
import { GatewayRequestError, UnknownWorkflowError } from './errors.js'

/** References that identify the work and its audit trail, carried on every result. */
export interface AuditRefs {
  readonly runId?: string
  readonly taskId?: string
  /** Parameters that re-query `/audit` for this work's entries. */
  readonly auditQuery?: Readonly<Record<string, string>>
}

/** A normalized OpenClaw tool result: status + payload + audit references. */
export interface ToolResult<T = unknown> {
  readonly ok: boolean
  readonly data: T
  readonly refs: AuditRefs
}

function refsForRun(runId: string): AuditRefs {
  return { runId, auditQuery: { runId } }
}

function fail(res: GatewayResponse, workflowId?: string): never {
  if (res.status === 404 && workflowId !== undefined) throw new UnknownWorkflowError(workflowId)
  // 401/403 already became GatewayAuthError inside the client.
  const msg =
    typeof res.body === 'object' && res.body !== null && 'error' in res.body
      ? String((res.body as { error: unknown }).error)
      : `gateway request failed with status ${res.status}`
  throw new GatewayRequestError(msg, res.status)
}

export interface RunToolInput {
  readonly workflowId: string
  readonly input?: unknown
  readonly idempotencyKey?: string
}

/** `skelm_run` — run a workflow synchronously, returning its final state. */
export async function skelmRun(client: GatewayHttpClient, args: RunToolInput): Promise<ToolResult> {
  const res = await client.request({
    method: 'POST',
    path: `/pipelines/${encodeURIComponent(args.workflowId)}/run`,
    body: args.input === undefined ? {} : args.input,
    ...(args.idempotencyKey ? { query: { idempotencyKey: args.idempotencyKey } } : {}),
  })
  if (!res.ok) fail(res, args.workflowId)
  const body = res.body as { runId?: string } & Record<string, unknown>
  return {
    ok: true,
    data: body,
    refs: body.runId !== undefined ? refsForRun(body.runId) : {},
  }
}

export interface StartToolInput {
  readonly workflowId: string
  readonly input?: unknown
  readonly parentRunId?: string
  readonly parentStepId?: string
  /** Where the detached task's result should be delivered when it completes. */
  readonly deliveryTarget?: DeliveryTarget
}

/** `skelm_start` — start a detached, tracked task; returns the task record. */
export async function skelmStart(
  client: GatewayHttpClient,
  args: StartToolInput,
): Promise<ToolResult> {
  const res = await client.request({
    method: 'POST',
    path: '/v1/tasks',
    body: {
      workflowId: args.workflowId,
      ...(args.input !== undefined ? { input: args.input } : {}),
      ...(args.parentRunId !== undefined ? { parentRunId: args.parentRunId } : {}),
      ...(args.parentStepId !== undefined ? { parentStepId: args.parentStepId } : {}),
      ...(args.deliveryTarget !== undefined ? { deliveryTarget: args.deliveryTarget } : {}),
    },
  })
  if (!res.ok) fail(res, args.workflowId)
  const task = res.body as { taskId?: string; childRunId?: string } & Record<string, unknown>
  const refs: AuditRefs = {
    ...(task.taskId !== undefined ? { taskId: task.taskId } : {}),
    ...(task.childRunId !== undefined ? { runId: task.childRunId } : {}),
    ...(task.childRunId !== undefined ? { auditQuery: { runId: task.childRunId } } : {}),
  }
  return { ok: true, data: task, refs }
}

export interface StatusToolInput {
  /** Provide exactly one. A task id reads `/v1/tasks/:id`; a run id reads its events. */
  readonly taskId?: string
  readonly runId?: string
}

/** `skelm_status` — status of a detached task or an in-flight/finished run. */
export async function skelmStatus(
  client: GatewayHttpClient,
  args: StatusToolInput,
): Promise<ToolResult> {
  if (args.taskId !== undefined) {
    const res = await client.request({
      method: 'GET',
      path: `/v1/tasks/${encodeURIComponent(args.taskId)}`,
    })
    if (!res.ok) fail(res)
    const task = res.body as { taskId?: string; childRunId?: string } & Record<string, unknown>
    const refs: AuditRefs = {
      taskId: args.taskId,
      ...(task.childRunId !== undefined ? { runId: task.childRunId } : {}),
      ...(task.childRunId !== undefined ? { auditQuery: { runId: task.childRunId } } : {}),
    }
    return { ok: true, data: task, refs }
  }
  if (args.runId !== undefined) {
    const res = await client.request({
      method: 'GET',
      path: `/runs/${encodeURIComponent(args.runId)}/events`,
    })
    if (!res.ok) fail(res)
    return { ok: true, data: res.body, refs: refsForRun(args.runId) }
  }
  throw new Error('skelm_status requires a runId or taskId')
}

export interface CancelToolInput {
  readonly taskId?: string
  readonly runId?: string
}

/** `skelm_cancel` — cancel a detached task (and its child run) or a run. */
export async function skelmCancel(
  client: GatewayHttpClient,
  args: CancelToolInput,
): Promise<ToolResult> {
  if (args.taskId !== undefined) {
    const res = await client.request({
      method: 'POST',
      path: `/v1/tasks/${encodeURIComponent(args.taskId)}/cancel`,
    })
    if (!res.ok) fail(res)
    const task = res.body as { childRunId?: string } & Record<string, unknown>
    const refs: AuditRefs = {
      taskId: args.taskId,
      ...(task.childRunId !== undefined ? { runId: task.childRunId } : {}),
    }
    return { ok: true, data: task, refs }
  }
  if (args.runId !== undefined) {
    const res = await client.request({
      method: 'DELETE',
      path: `/runs/${encodeURIComponent(args.runId)}`,
    })
    if (!res.ok) fail(res)
    return { ok: true, data: res.body, refs: refsForRun(args.runId) }
  }
  throw new Error('skelm_cancel requires a runId or taskId')
}

export interface AuditToolInput {
  readonly runId?: string
  readonly actor?: string
  readonly action?: string
  readonly since?: string
  readonly until?: string
  readonly limit?: number
  readonly before?: string
}

/** `skelm_audit` — query the gateway's hash-chained audit refs. */
export async function skelmAudit(
  client: GatewayHttpClient,
  args: AuditToolInput,
): Promise<ToolResult> {
  const query: Record<string, string> = {}
  if (args.runId !== undefined) query.runId = args.runId
  if (args.actor !== undefined) query.actor = args.actor
  if (args.action !== undefined) query.action = args.action
  if (args.since !== undefined) query.since = args.since
  if (args.until !== undefined) query.until = args.until
  if (args.limit !== undefined) query.limit = String(args.limit)
  if (args.before !== undefined) query.before = args.before
  const res = await client.request({ method: 'GET', path: '/audit', query })
  if (!res.ok) fail(res)
  return {
    ok: true,
    data: res.body,
    refs: args.runId !== undefined ? { runId: args.runId, auditQuery: { runId: args.runId } } : {},
  }
}

export interface WorkflowSearchInput {
  /** Case-insensitive substring filter over workflow id; lists all when absent. */
  readonly query?: string
}

interface PipelineEntry {
  readonly id: string
  readonly [k: string]: unknown
}

/** `skelm_workflow_search` — list registered workflows, optionally filtered. */
export async function skelmWorkflowSearch(
  client: GatewayHttpClient,
  args: WorkflowSearchInput = {},
): Promise<ToolResult<readonly PipelineEntry[]>> {
  const res = await client.request({ method: 'GET', path: '/pipelines' })
  if (!res.ok) fail(res)
  const raw = res.body
  const list: readonly PipelineEntry[] = Array.isArray(raw)
    ? (raw as PipelineEntry[])
    : Array.isArray((raw as { pipelines?: unknown }).pipelines)
      ? (raw as { pipelines: PipelineEntry[] }).pipelines
      : []
  const q = args.query?.toLowerCase()
  const matched = q === undefined ? list : list.filter((p) => p.id.toLowerCase().includes(q))
  return { ok: true, data: matched, refs: {} }
}
