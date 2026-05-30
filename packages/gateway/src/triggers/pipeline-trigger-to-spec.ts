import { parseDuration } from '@skelm/core'
import type { TriggerSpec } from './types.js'

/** Largest delay Node's setInterval honors; above this it silently clamps to 1ms. */
export const MAX_INTERVAL_MS = 2_147_483_647

/**
 * A valid interval is a finite delay in [1, MAX_INTERVAL_MS]. Node's setInterval
 * clamps delays <= 0 (and > MAX) to 1ms, so accepting those would arm a ~1ms
 * tight loop (a DoS). Reject them at the spec-building boundary instead.
 */
export function isValidIntervalMs(everyMs: number): boolean {
  return Number.isFinite(everyMs) && everyMs >= 1 && everyMs <= MAX_INTERVAL_MS
}

/**
 * Translate a pipeline-declared trigger into a full TriggerSpec. The
 * pipeline file omits `workflowId` (filled here from the registry id) and
 * may omit `id` (defaulted to `<workflowId>#<kind>[-i]`). Returns undefined
 * when the kind is unrecognized.
 */
export function pipelineTriggerToSpec(
  workflowId: string,
  trigger: Record<string, unknown>,
  index: number,
): TriggerSpec | undefined {
  const kind = trigger.kind as string | undefined
  const explicitId = typeof trigger.id === 'string' ? trigger.id : undefined
  const defaultId = `${workflowId}#${kind ?? 'trigger'}${index === 0 ? '' : `-${index}`}`
  const id = explicitId ?? defaultId
  switch (kind) {
    case 'queue':
      return {
        kind: 'queue',
        id,
        workflowId,
        driver: trigger.sourceId as string,
        ...(trigger.config !== undefined && {
          config: trigger.config as Record<string, unknown>,
        }),
      }
    case 'webhook': {
      const isGraph = trigger.provider === 'ms-graph'
      const clientState =
        typeof trigger.clientState === 'string' && trigger.clientState !== ''
          ? trigger.clientState
          : undefined
      // Default-deny: refuse to translate an ms-graph webhook without a
      // clientState — Graph does not sign payloads (issue #161). Returning
      // undefined surfaces an "unknown trigger kind" warning in the boot
      // log, which is loud enough that the pipeline author will notice.
      if (isGraph && clientState === undefined) return undefined
      return {
        kind: 'webhook',
        id,
        workflowId,
        path: trigger.path as string,
        ...(trigger.method !== undefined && { method: trigger.method as string }),
        ...(trigger.secret !== undefined && { secret: trigger.secret as string }),
        ...((trigger.provider === 'slack' || trigger.provider === 'ms-graph') && {
          provider: trigger.provider,
        }),
        ...(clientState !== undefined && { clientState }),
        // Without forwarding `dedupe`, every pipeline-declared webhook ran
        // without idempotency; same delivery id dispatched twice. The
        // coordinator + HTTP route both honor the field once the spec
        // carries it.
        ...(trigger.dedupe !== undefined && {
          dedupe: trigger.dedupe as { header: string; ttlMs?: number },
        }),
      }
    }
    case 'event-source':
      return {
        kind: 'event-source',
        id,
        workflowId,
        source: trigger.source as 'websocket' | 'sse' | 'rss' | 'custom',
        options: (trigger.options as Record<string, unknown>) ?? {},
        ...(typeof trigger.filter === 'object' &&
          trigger.filter !== null && { filter: trigger.filter as Record<string, unknown> }),
      } as TriggerSpec
    case 'file-watch':
      return {
        kind: 'file-watch',
        id,
        workflowId,
        path: trigger.path as string,
        ...(trigger.events !== undefined && {
          events: trigger.events as ('create' | 'update' | 'delete')[],
        }),
        ...(trigger.debounceMs !== undefined && { debounceMs: trigger.debounceMs as number }),
      }
    case 'cron': {
      const tz = typeof trigger.tz === 'string' ? trigger.tz : undefined
      return {
        kind: 'cron',
        id,
        workflowId,
        cron: trigger.cron as string,
        ...(tz !== undefined && { tz }),
      }
    }
    case 'interval': {
      const everyMsRaw = trigger.everyMs
      const everyRaw = trigger.every
      let everyMs: number | undefined
      if (typeof everyMsRaw === 'number') {
        everyMs = everyMsRaw
      } else if (typeof everyRaw === 'string') {
        // parseDuration throws on a malformed string (e.g. '5min', the valid
        // unit is 'm'). The schedules HTTP route catches that and rejects with
        // 400; here an uncaught throw would crash trigger discovery at gateway
        // boot / project activation — one typo'd trigger taking down the whole
        // workflow load — instead of skipping the bad trigger like every other
        // invalid config. Treat an unparseable duration as invalid.
        try {
          everyMs = parseDuration(everyRaw)
        } catch {
          return undefined
        }
      }
      if (everyMs === undefined || !isValidIntervalMs(everyMs)) return undefined
      return {
        kind: 'interval',
        id,
        workflowId,
        everyMs,
        ...(typeof everyRaw === 'string' && { every: everyRaw }),
      }
    }
    case 'github-pr':
      // The github-pr primitive (commit e08f167) is sugar over a webhook
      // trigger with GitHub-Delivery dedupe pre-configured. Translate here
      // so a pipeline can declare it without manually wiring
      // registerGitHubPrTrigger() from @skelm/integrations.
      //
      // Per-event filtering (events/filter.dropBotAuthors/filter.repos) and
      // payload normalization to GitHubPrPayload are still the pipeline's
      // responsibility — the first step should call
      // `normalizeGitHubPrEvent(headers['x-github-event'], body, spec)`
      // from `@skelm/integrations`. Until a kind-aware pre-dispatch hook
      // lands on TriggerCoordinator, the run input is the raw
      // `{body, headers, path, method, deliveredAt}` envelope produced by
      // the underlying webhook trigger.
      return {
        kind: 'webhook',
        id,
        workflowId,
        path: trigger.path as string,
        method: 'POST',
        ...(trigger.secret !== undefined && { secret: trigger.secret as string }),
        dedupe: {
          header: 'X-GitHub-Delivery',
          ttlMs: (trigger.dedupeTtlMs as number | undefined) ?? 24 * 60 * 60 * 1000,
        },
      }
    default:
      return undefined
  }
}
