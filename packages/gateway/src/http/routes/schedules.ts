import { parseDuration } from '@skelm/core'
import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import type { TriggerRegistration, TriggerSpec } from '../../triggers/types.js'

export function registerScheduleRoutes(router: Router, gateway: Gateway): void {
  router.get(
    '/triggers',
    eventHandler(async () => gateway.managers.triggers.list()),
  )

  router.post(
    '/triggers/:id/fire',
    eventHandler(async (event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'trigger id required' })
      await gateway.managers.triggers.fire(id)
      return { ok: true }
    }),
  )

  router.get(
    '/schedules',
    eventHandler(async () =>
      gateway.managers.triggers.list().map((reg) => registrationToSchedule(reg)),
    ),
  )

  router.post(
    '/schedules',
    eventHandler(async (event) => {
      const body = (await readBody(event).catch(() => ({}))) as Record<string, unknown>
      const id = body.id
      const workflowId = body.workflowId
      const trigger = body.trigger as { kind?: string } | undefined
      if (typeof id !== 'string' || id === '') {
        throw createError({ statusCode: 400, message: 'id required' })
      }
      if (typeof workflowId !== 'string' || workflowId === '') {
        throw createError({ statusCode: 400, message: 'workflowId required' })
      }
      if (trigger === undefined || typeof trigger.kind !== 'string') {
        throw createError({ statusCode: 400, message: 'trigger.kind required' })
      }
      // Validate overlap strictly rather than silently coercing — #184: a
      // client sending `overlap: 'fail-fast'` (a value that DOES exist in
      // some scheduler libraries) used to be cast to undefined → default
      // 'skip', so the operator thought they had stricter semantics than
      // they did. Refuse unknown values up front.
      const VALID_OVERLAP = ['skip', 'queue', 'cancel'] as const
      const rawOverlap = body.overlap
      let overlap: 'skip' | 'queue' | 'cancel' = 'skip'
      if (rawOverlap !== undefined) {
        if (
          typeof rawOverlap !== 'string' ||
          !(VALID_OVERLAP as readonly string[]).includes(rawOverlap)
        ) {
          throw createError({
            statusCode: 400,
            message: `invalid overlap: ${JSON.stringify(rawOverlap)} — expected one of ${VALID_OVERLAP.join(', ')}`,
          })
        }
        overlap = rawOverlap as 'skip' | 'queue' | 'cancel'
      }
      const spec = scheduleTriggerToSpec(id, workflowId, trigger as { kind: string })
      if (spec === 'invalid') {
        throw createError({ statusCode: 400, message: 'invalid trigger configuration' })
      }
      // Persist the optional `input` JSON so cron / interval / manual / at /
      // immediate fires can pass it as the pipeline input. Queue / webhook
      // sources still supply per-fire payloads that take precedence.
      const reg = gateway.managers.triggers.register(
        spec,
        overlap,
        body.input !== undefined ? { input: body.input } : {},
      )
      if (reg.lastError !== undefined) {
        throw createError({ statusCode: 400, message: `failed to register: ${reg.lastError}` })
      }
      return registrationToSchedule(reg)
    }),
  )

  router.delete(
    '/schedules/:id',
    eventHandler(async (event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'schedule id required' })
      const existing = gateway.managers.triggers.get(id)
      if (existing === undefined) {
        throw createError({ statusCode: 404, message: `schedule not found: ${id}` })
      }
      gateway.managers.triggers.unregister(id)
      return { ok: true, id }
    }),
  )
}

function scheduleTriggerToSpec(
  id: string,
  workflowId: string,
  trigger: { kind: string } & Record<string, unknown>,
): TriggerSpec | 'invalid' {
  switch (trigger.kind) {
    case 'immediate':
      return { kind: 'immediate', id, workflowId }
    case 'manual':
      return { kind: 'manual', id, workflowId }
    case 'at': {
      const when = trigger.when
      if (typeof when !== 'string') return 'invalid'
      return { kind: 'at', id, workflowId, when }
    }
    case 'cron': {
      const expr = trigger.expression
      if (typeof expr !== 'string') return 'invalid'
      const spec: TriggerSpec = { kind: 'cron', id, workflowId, cron: expr }
      if (typeof trigger.tz === 'string') spec.tz = trigger.tz
      return spec
    }
    case 'interval': {
      const everyMs = trigger.everyMs
      const every = trigger.every
      if (typeof everyMs !== 'number' && typeof every !== 'string') return 'invalid'
      let resolvedEveryMs: number
      if (typeof everyMs === 'number') {
        resolvedEveryMs = everyMs
      } else {
        try {
          resolvedEveryMs = parseDuration(every as string)
        } catch {
          return 'invalid'
        }
      }
      return {
        kind: 'interval',
        id,
        workflowId,
        everyMs: resolvedEveryMs,
        ...(typeof every === 'string' && { every }),
      }
    }
    case 'webhook': {
      const path = trigger.path
      if (typeof path !== 'string' || path === '') return 'invalid'
      const spec: TriggerSpec = { kind: 'webhook', id, workflowId, path }
      if (typeof trigger.method === 'string') spec.method = trigger.method
      if (typeof trigger.secret === 'string') spec.secret = trigger.secret
      if (trigger.provider === 'slack' || trigger.provider === 'ms-graph') {
        spec.provider = trigger.provider
      }
      if (typeof trigger.clientState === 'string' && trigger.clientState !== '') {
        spec.clientState = trigger.clientState
      }
      // Default-deny: Graph does not sign payloads, so without clientState
      // the webhook URL would be the only authentication boundary.
      // Refuse to register an unauthenticated ms-graph trigger (issue #161).
      if (spec.provider === 'ms-graph' && spec.clientState === undefined) {
        return 'invalid'
      }
      return spec
    }
    case 'event-source': {
      const source = trigger.source
      if (source !== 'websocket' && source !== 'sse' && source !== 'rss' && source !== 'custom') {
        return 'invalid'
      }
      const options =
        typeof trigger.options === 'object' && trigger.options !== null
          ? (trigger.options as Record<string, unknown>)
          : {}
      const spec: TriggerSpec = {
        kind: 'event-source',
        id,
        workflowId,
        source,
        options: options as Extract<TriggerSpec, { kind: 'event-source' }>['options'],
      }
      if (typeof trigger.filter === 'object' && trigger.filter !== null) {
        spec.filter = trigger.filter as Record<string, unknown>
      }
      return spec
    }
    case 'file-watch': {
      const path = trigger.path
      if (typeof path !== 'string' || path === '') return 'invalid'
      const spec: TriggerSpec = { kind: 'file-watch', id, workflowId, path }
      if (Array.isArray(trigger.events)) {
        const events = trigger.events.filter(
          (event): event is 'create' | 'update' | 'delete' =>
            event === 'create' || event === 'update' || event === 'delete',
        )
        if (events.length > 0) spec.events = events
      }
      if (typeof trigger.debounceMs === 'number') spec.debounceMs = trigger.debounceMs
      return spec
    }
    case 'poll': {
      const everyMs = trigger.everyMs
      const sourceFnId = trigger.sourceFnId
      if (typeof everyMs !== 'number' || typeof sourceFnId !== 'string') return 'invalid'
      const spec: TriggerSpec = { kind: 'poll', id, workflowId, everyMs, sourceFnId }
      if (typeof trigger.dedupeKeyFnId === 'string') spec.dedupeKeyFnId = trigger.dedupeKeyFnId
      return spec
    }
    case 'queue': {
      const driver = trigger.driver
      if (typeof driver !== 'string') return 'invalid'
      const spec: TriggerSpec = { kind: 'queue', id, workflowId, driver }
      if (typeof trigger.config === 'object' && trigger.config !== null) {
        spec.config = trigger.config as Record<string, unknown>
      }
      return spec
    }
    default:
      return 'invalid'
  }
}

function registrationToSchedule(reg: TriggerRegistration): {
  id: string
  workflowId: string
  trigger: Record<string, unknown>
  overlap: string
  enabled: boolean
  fired: number
  inflight: boolean
  input?: unknown
  lastFiredAt?: string
  lastError?: string
} {
  const spec = reg.spec
  let trigger: Record<string, unknown>
  switch (spec.kind) {
    case 'cron':
      trigger = {
        kind: 'cron',
        expression: spec.cron,
        ...(spec.tz !== undefined && { tz: spec.tz }),
      }
      break
    case 'interval':
      trigger = {
        kind: 'interval',
        everyMs: spec.everyMs,
        ...(spec.every !== undefined && { every: spec.every }),
      }
      break
    case 'manual':
      trigger = { kind: 'manual' }
      break
    case 'immediate':
      trigger = { kind: 'immediate' }
      break
    case 'at':
      trigger = { kind: 'at', when: spec.when }
      break
    case 'webhook':
      trigger = { kind: 'webhook', path: spec.path }
      if (spec.method !== undefined) trigger.method = spec.method
      if (spec.provider !== undefined) trigger.provider = spec.provider
      // Don't expose the secret or the ms-graph clientState on read; they
      // are credentials, not metadata.
      break
    case 'event-source':
      trigger = { kind: 'event-source', source: spec.source, options: spec.options }
      if (spec.filter !== undefined) trigger.filter = spec.filter
      break
    case 'file-watch':
      trigger = { kind: 'file-watch', path: spec.path }
      if (spec.events !== undefined) trigger.events = [...spec.events]
      if (spec.debounceMs !== undefined) trigger.debounceMs = spec.debounceMs
      break
    case 'poll':
      trigger = { kind: 'poll', everyMs: spec.everyMs, sourceFnId: spec.sourceFnId }
      if (spec.dedupeKeyFnId !== undefined) trigger.dedupeKeyFnId = spec.dedupeKeyFnId
      break
    case 'queue':
      trigger = { kind: 'queue', driver: spec.driver }
      if (spec.config !== undefined) trigger.config = spec.config
      break
  }
  const out: ReturnType<typeof registrationToSchedule> = {
    id: spec.id,
    workflowId: spec.workflowId,
    trigger,
    overlap: reg.overlap,
    enabled: true,
    fired: reg.fired,
    inflight: reg.inflight,
  }
  if (reg.input !== undefined) out.input = reg.input
  if (reg.lastFiredAt !== undefined) out.lastFiredAt = reg.lastFiredAt
  if (reg.lastError !== undefined) out.lastError = reg.lastError
  return out
}
