// One enforced turn of a persistent agent.
//
// A persistent agent has no resident process: each trigger fire runs exactly
// one bounded, gateway-enforced, audited turn. We load the durable conversation
// for the payload's session key, synthesize a single-step agent pipeline, and
// run it through the SAME Runner + enforcement path a normal triggered pipeline
// uses (so permissions, audit, egress, and agentmemory all apply — including the
// operator-gated unrestricted bypass). The updated conversation is persisted so
// the next fire continues the thread across restarts.

import {
  type BackendRegistry,
  type PersistentAgent,
  Runner,
  agent,
  createSessionRecord,
  defaultPromptOf,
  defaultReplyOf,
  loadSession,
  pipeline,
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

export interface RunPersistentTurnOptions {
  gateway: Gateway
  agent: PersistentAgent
  payload: unknown
  triggerId: string
  backends?: BackendRegistry
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
 * from author input).
 */
export async function runPersistentTurn(
  opts: RunPersistentTurnOptions,
): Promise<{ output: unknown }> {
  const { gateway, agent: a, payload, triggerId } = opts
  const sessionKey = a.sessionKey(payload)
  const userText = (a.promptOf ?? defaultPromptOf)(payload)
  const lockKey = `${a.id}::${sessionKey}`

  return withSessionLock(lockKey, async () => {
    const rec =
      (await loadSession(gateway.runStore, a.id, sessionKey)) ??
      createSessionRecord(a.id, sessionKey)
    const history = Array.isArray(rec.conversation) ? (rec.conversation as TurnMessage[]) : []

    const historyBlock = renderHistory(history)
    const system =
      [a.system, historyBlock].filter((s): s is string => !!s).join('\n\n') || undefined

    const turn = pipeline<unknown, { text: string }>({
      id: a.id,
      steps: [
        agent({
          id: 'turn',
          ...(a.backend !== undefined && { backend: a.backend }),
          ...(system !== undefined && { system }),
          prompt: userText,
          ...(a.permissions !== undefined && { permissions: a.permissions }),
          ...(a.maxTurns !== undefined && { maxTurns: a.maxTurns }),
        }),
      ],
      finalize: (ctx) => ({ text: ((ctx.steps.turn as { text?: string }).text ?? '').trim() }),
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
    gateway.metrics?.recordTriggerFire(triggerId)

    const controller = new AbortController()
    const runId = crypto.randomUUID()
    gateway.registerRun(runId, controller, runner)
    try {
      const handle = runner.start(
        turn,
        {},
        {
          runId,
          signal: controller.signal,
          triggerId,
          unrestrictedGrant: gateway.isUnrestrictedGranted(a.id),
          ...gateway.egressRunOptions(),
          ...gateway.agentmemoryRunOptions(),
        },
      )
      const result = await handle.wait()
      const text = (result.output as { text?: string } | undefined)?.text ?? ''

      const next = {
        ...rec,
        conversation: [
          ...history,
          { role: 'user', content: userText },
          { role: 'assistant', content: text },
        ] satisfies TurnMessage[],
        turns: rec.turns + 1,
      }
      await saveSession(gateway.runStore, next)

      return { output: (a.replyOf ?? defaultReplyOf)(text) }
    } finally {
      gateway.unregisterRun(runId)
    }
  })
}
