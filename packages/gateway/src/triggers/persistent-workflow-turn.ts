// One enforced turn of a persistent workflow.
//
// A persistent workflow has no resident process: each trigger fire runs FRESH
// preamble steps followed by exactly one bounded, gateway-enforced, audited
// agent turn. We load the durable conversation for the payload's session key,
// synthesize a pipeline whose terminal `'turn'` step is the persistent agent
// (preceded by the author's preamble steps), and run it through the SAME Runner
// + enforcement path a normal triggered pipeline uses (so permissions, audit,
// egress, and agentmemory all apply — including the operator-gated unrestricted
// bypass). The updated conversation is persisted so the next fire continues the
// thread across restarts.

import { dirname } from 'node:path'
import {
  type BackendRegistry,
  type Context,
  PERSISTENT_TURN_STEP_ID,
  type PersistentWorkflow,
  type RunEvent,
  Runner,
  acquireSession,
  agent,
  createSessionRecord,
  defaultPromptOf,
  defaultReplyOf,
  pipeline,
  releaseSession,
  saveSession,
} from '@skelm/core'
import type { Gateway } from '../lifecycle/gateway.js'

/** One stored conversation message. */
interface TurnMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Keep the injected history bounded so a long-lived chat doesn't grow the
 *  prompt without limit. The full transcript still lives in the session record. */
const MAX_HISTORY_MESSAGES = 40

export interface RunPersistentWorkflowTurnOptions {
  gateway: Gateway
  workflow: PersistentWorkflow
  payload: unknown
  triggerId: string
  backends?: BackendRegistry
  /** Absolute path to the workflow source file; resolves a relative `agent.agentDef`. */
  workflowPath?: string
  /** Forwarded to the runner so callers observe run events as the turn streams. */
  onEvent?: (event: RunEvent) => void
}

/** Serialize per session key so two fires for the same chat don't race the
 *  load→run→save cycle. One process, one map; multi-process safety would use
 *  the store's casState. */
const sessionLocks = new Map<string, Promise<unknown>>()

async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  sessionLocks.set(
    key,
    next.catch(() => undefined),
  )
  try {
    return await next
  } finally {
    if (sessionLocks.get(key) === next.catch(() => undefined)) sessionLocks.delete(key)
  }
}

function renderHistory(history: readonly TurnMessage[]): string {
  if (history.length === 0) return ''
  const recent = history.slice(-MAX_HISTORY_MESSAGES)
  const lines = recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
  return `Conversation so far:\n${lines.join('\n')}`
}

/**
 * Run one turn and return the reply object the queue driver's `onResult` posts.
 * Mirrors the dispatcher's Runner construction so the turn runs through the
 * gateway's real enforcement, with the unrestricted grant resolved here (never
 * from author input). Preamble steps run first under their own declared
 * permissions; only the terminal `'turn'` step carries `agent.permissions`.
 */
export async function runPersistentWorkflowTurn(
  opts: RunPersistentWorkflowTurnOptions,
): Promise<{ output: unknown }> {
  const { gateway, workflow: wf, payload, triggerId } = opts
  const a = wf.agent
  const sessionKey = a.sessionKey(payload)
  const lockKey = `${wf.id}::${sessionKey}`

  return withSessionLock(lockKey, async () => {
    // In-process lock above serializes within ONE gateway; the durable
    // acquireSession() below is the multi-process safety net (rejects when
    // another gateway replica already holds the session). The ownerId is
    // stable across reruns from the same gateway process so a crash recovery
    // can release without churning the cas.
    const ownerId = `gateway:${process.pid}`
    const acquired = await acquireSession(gateway.runStore, wf.id, sessionKey, ownerId)
    const rec = acquired ?? createSessionRecord(wf.id, sessionKey)
    const history = Array.isArray(rec.conversation) ? (rec.conversation as TurnMessage[]) : []

    const historyBlock = renderHistory(history)
    const system =
      [a.system, historyBlock].filter((s): s is string => !!s).join('\n\n') || undefined

    // The terminal prompt is resolved inside the run because it may read preamble
    // step outputs (ctx.steps). Capture the resolved text so stored history
    // records what the agent actually saw; the closure runs once, for 'turn'.
    let resolvedPrompt = ''
    const turn = pipeline<unknown, { text: string }>({
      id: wf.id,
      // baseDir is what populates runtime.pipelineBaseDir, against which the
      // handler resolves a relative `agentDef`. Passing workflowPath to
      // runner.start alone would only set the run record, not the resolver base.
      ...(opts.workflowPath !== undefined && { baseDir: dirname(opts.workflowPath) }),
      steps: [
        ...(wf.steps ?? []),
        agent({
          id: PERSISTENT_TURN_STEP_ID,
          ...(a.backend !== undefined && { backend: a.backend }),
          ...(system !== undefined && { system }),
          ...(a.agentDef !== undefined && { agentDef: a.agentDef }),
          ...(a.systemPromptMode !== undefined && { systemPromptMode: a.systemPromptMode }),
          ...(a.systemPromptIncludeAgentDef !== undefined && {
            systemPromptIncludeAgentDef: a.systemPromptIncludeAgentDef,
          }),
          prompt: async (ctx) => {
            resolvedPrompt = a.prompt ? await a.prompt(ctx as Context) : defaultPromptOf(ctx.input)
            return resolvedPrompt
          },
          ...(a.permissions !== undefined && { permissions: a.permissions }),
          ...(a.maxTurns !== undefined && { maxTurns: a.maxTurns }),
        }),
      ],
      finalize: (ctx) => ({
        text: ((ctx.steps[PERSISTENT_TURN_STEP_ID] as { text?: string }).text ?? '').trim(),
      }),
    })

    const enforcement = gateway.enforcement
    const runner = new Runner({
      approvalGate: enforcement.approvalGate,
      secretResolver: enforcement.secretResolver,
      auditWriter: enforcement.auditWriter,
      store: gateway.runStore,
      workspaceManager: gateway.workspaceManager,
      ...(opts.backends !== undefined && { backends: opts.backends }),
    })
    gateway.attachMetricsBus(runner.events)
    gateway.attachOtelBus(runner.events)
    gateway.metrics?.recordTriggerFire(triggerId)

    const controller = new AbortController()
    const runId = crypto.randomUUID()
    gateway.registerRun(runId, controller, runner)
    try {
      const handle = runner.start(turn, payload ?? {}, {
        runId,
        signal: controller.signal,
        triggerId,
        unrestrictedGrant: gateway.isUnrestrictedGranted(wf.id),
        ...(opts.workflowPath !== undefined && { workflowPath: opts.workflowPath }),
        ...gateway.defaultPermissionRunOptions(wf.id),
        ...gateway.egressRunOptions(),
        ...gateway.agentmemoryRunOptions(),
        ...(opts.onEvent !== undefined && { onEvent: opts.onEvent }),
      })
      const result = await handle.wait()
      // A preamble (or terminal) step failure resolves the run as `failed`
      // rather than rejecting. Never persist a partial turn: surface the error
      // so the dispatcher records it and no reply is posted.
      if (result.status !== 'completed') {
        throw new Error(
          `persistent-workflow turn ${wf.id} did not complete (status: ${result.status})${
            result.error ? `: ${result.error.message}` : ''
          }`,
        )
      }
      const text = (result.output as { text?: string } | undefined)?.text ?? ''

      const next = {
        ...rec,
        conversation: [
          ...history,
          { role: 'user', content: resolvedPrompt },
          { role: 'assistant', content: text },
        ] satisfies TurnMessage[],
        turns: rec.turns + 1,
      }
      await saveSession(gateway.runStore, next)

      return { output: (a.reply ?? defaultReplyOf)(text) }
    } finally {
      gateway.unregisterRun(runId)
      // Release the durable advisory lock on every exit path. A finally
      // here covers thrown runs (preamble failure, abort, internal error)
      // as well as completion — a stuck `active` flag would otherwise
      // block subsequent fires until an operator cleared it manually.
      await releaseSession(gateway.runStore, wf.id, sessionKey, ownerId).catch(() => {})
    }
  })
}
