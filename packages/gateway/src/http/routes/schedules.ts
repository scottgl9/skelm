import { parseDuration } from '@skelm/core'
import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import { isValidIntervalMs } from '../../triggers/pipeline-trigger-to-spec.js'
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
      const status = await gateway.managers.triggers.fire(id)
      // F127: surface the overlap-policy decision so callers can distinguish
      // a dispatched fire from one that was skipped/cancelled because a
      // previous fire was still in flight. Webhook + queue paths still get
      // their own bespoke responses on the routes below; this is only the
      // manual-fire endpoint that operators hit directly.
      switch (status) {
        case 'dispatched':
        case 'queued':
          return { ok: true, status }
        case 'skipped':
        case 'cancelled':
          throw createError({
            statusCode: 409,
            message: `trigger ${id} ${status} by overlap policy (previous fire still in flight)`,
            data: { ok: false, status },
          })
        case 'stopping':
          throw createError({
            statusCode: 503,
            message: 'gateway is stopping; refusing new fires',
            data: { ok: false, status },
          })
        case 'unknown':
          throw createError({ statusCode: 404, message: `trigger ${id} not found` })
      }
    }),
  )

  router.get(
    '/schedules',
    eventHandler(async () =>
      gateway.managers.triggers
        .list()
        .map((reg) =>
          registrationToSchedule(
            reg,
            gateway.managers.triggers.queueDepth(reg.spec.id),
            gateway.managers.triggers.runningCount(reg.spec.id),
          ),
        ),
    ),
  )

  router.get(
    '/schedules/:id',
    eventHandler(async (event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'schedule id required' })
      const reg = gateway.managers.triggers.get(id)
      if (reg === undefined) {
        throw createError({ statusCode: 404, message: `schedule not found: ${id}` })
      }
      return registrationToSchedule(
        reg,
        gateway.managers.triggers.queueDepth(id),
        gateway.managers.triggers.runningCount(id),
      )
    }),
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
      if ('error' in spec) {
        throw createError({
          statusCode: 400,
          message: `invalid trigger configuration: ${spec.error}`,
        })
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
): TriggerSpec | { error: string } {
  switch (trigger.kind) {
    case 'immediate':
      return { kind: 'immediate', id, workflowId }
    case 'manual':
      return { kind: 'manual', id, workflowId }
    case 'at': {
      const when = trigger.when
      if (typeof when !== 'string')
        return { error: 'at trigger requires string `when` (ISO timestamp)' }
      return { kind: 'at', id, workflowId, when }
    }
    case 'cron': {
      const expr = trigger.expression
      if (typeof expr !== 'string') return { error: 'cron trigger requires string `expression`' }
      const spec: TriggerSpec = { kind: 'cron', id, workflowId, cron: expr }
      if (typeof trigger.tz === 'string') spec.tz = trigger.tz
      return spec
    }
    case 'interval': {
      const everyMs = trigger.everyMs
      const every = trigger.every
      if (typeof everyMs !== 'number' && typeof every !== 'string') {
        return {
          error: 'interval trigger requires `everyMs` (number) or `every` (duration string)',
        }
      }
      let resolvedEveryMs: number
      if (typeof everyMs === 'number') {
        resolvedEveryMs = everyMs
      } else {
        try {
          resolvedEveryMs = parseDuration(every as string)
        } catch (e) {
          return { error: `interval trigger: cannot parse \`every\` (${(e as Error).message})` }
        }
      }
      // Reject intervals outside setInterval's effective range. Node silently
      // clamps delays <= 0 (and > 2^31-1) to 1ms, so an unvalidated everyMs of
      // -5 / 0 / 1e12 would arm a ~1ms tight loop and fire the workflow ~1000x/s
      // — a denial of service. The cron path already validates its expression.
      if (!isValidIntervalMs(resolvedEveryMs)) {
        return {
          error: `interval trigger: everyMs=${resolvedEveryMs} out of supported range`,
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
      if (typeof path !== 'string' || path === '') {
        return { error: 'webhook trigger requires non-empty `path`' }
      }
      const spec: TriggerSpec = { kind: 'webhook', id, workflowId, path }
      if (typeof trigger.method === 'string') spec.method = trigger.method
      if (typeof trigger.secret === 'string') spec.secret = trigger.secret
      if (typeof trigger.replayWindowSeconds === 'number') {
        spec.replayWindowSeconds = trigger.replayWindowSeconds
      }
      if (typeof trigger.maxBodyBytes === 'number') {
        spec.maxBodyBytes = trigger.maxBodyBytes
      }
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
        return { error: 'ms-graph webhook requires `clientState` for authentication' }
      }
      return spec
    }
    case 'event-source': {
      const source = trigger.source
      if (source !== 'websocket' && source !== 'sse' && source !== 'rss' && source !== 'custom') {
        return {
          error: `event-source trigger: \`source\` must be websocket|sse|rss|custom (got ${JSON.stringify(source)})`,
        }
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
      if (typeof path !== 'string' || path === '') {
        return { error: 'file-watch trigger requires non-empty `path`' }
      }
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
      if (typeof everyMs !== 'number' || typeof sourceFnId !== 'string') {
        return { error: 'poll trigger requires `everyMs` (number) and `sourceFnId` (string)' }
      }
      // Same setInterval tight-loop guard as the interval kind.
      if (!isValidIntervalMs(everyMs)) {
        return { error: `poll trigger: everyMs=${everyMs} out of supported range` }
      }
      const spec: TriggerSpec = { kind: 'poll', id, workflowId, everyMs, sourceFnId }
      if (typeof trigger.dedupeKeyFnId === 'string') spec.dedupeKeyFnId = trigger.dedupeKeyFnId
      return spec
    }
    case 'queue': {
      const driver = trigger.driver
      if (typeof driver !== 'string') return { error: 'queue trigger requires string `driver`' }
      const spec: TriggerSpec = { kind: 'queue', id, workflowId, driver }
      if (typeof trigger.config === 'object' && trigger.config !== null) {
        spec.config = trigger.config as Record<string, unknown>
      }
      return spec
    }
    default:
      return { error: `unknown trigger kind: ${JSON.stringify(trigger.kind)}` }
  }
}

function registrationToSchedule(
  reg: TriggerRegistration,
  queued = 0,
  runningCount = 0,
): {
  id: string
  workflowId: string
  trigger: Record<string, unknown>
  overlap: string
  enabled: boolean
  fired: number
  inflight: boolean
  queued: number
  dropped: number
  runningCount: number
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
      if (spec.replayWindowSeconds !== undefined) {
        trigger.replayWindowSeconds = spec.replayWindowSeconds
      }
      if (spec.maxBodyBytes !== undefined) trigger.maxBodyBytes = spec.maxBodyBytes
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
    queued,
    dropped: reg.dropped,
    runningCount,
  }
  if (reg.input !== undefined) out.input = reg.input
  if (reg.lastFiredAt !== undefined) out.lastFiredAt = reg.lastFiredAt
  if (reg.lastError !== undefined) out.lastError = reg.lastError
  return out
}
