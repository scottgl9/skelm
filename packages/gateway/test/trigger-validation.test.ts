import { describe, expect, it } from 'vitest'
import { TriggerCoordinator } from '../src/index.js'
import {
  MAX_INTERVAL_MS,
  isValidIntervalMs,
  pipelineTriggerToSpec,
} from '../src/triggers/pipeline-trigger-to-spec.js'

// Regression: an interval trigger with everyMs <= 0 (or > 2^31-1) used to be
// accepted verbatim. Node's setInterval clamps such delays to 1ms, so the
// trigger would fire ~1000x/second — a denial of service. The cron path
// validated its expression; the interval path did not.
describe('interval everyMs validation (tight-loop DoS)', () => {
  describe('isValidIntervalMs', () => {
    it('rejects non-positive, non-finite, and out-of-range delays', () => {
      for (const bad of [
        0,
        -1,
        -5,
        -0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        MAX_INTERVAL_MS + 1,
      ]) {
        expect(isValidIntervalMs(bad)).toBe(false)
      }
    })
    it('accepts delays in [1, MAX_INTERVAL_MS]', () => {
      for (const ok of [1, 1000, 60_000, MAX_INTERVAL_MS]) {
        expect(isValidIntervalMs(ok)).toBe(true)
      }
    })
  })

  describe('pipelineTriggerToSpec', () => {
    it('refuses a pipeline-declared interval with everyMs <= 0', () => {
      expect(pipelineTriggerToSpec('wf', { kind: 'interval', everyMs: -5 }, 0)).toBeUndefined()
      expect(pipelineTriggerToSpec('wf', { kind: 'interval', everyMs: 0 }, 0)).toBeUndefined()
    })
    it('refuses an interval above the setInterval range', () => {
      expect(
        pipelineTriggerToSpec('wf', { kind: 'interval', everyMs: MAX_INTERVAL_MS + 1 }, 0),
      ).toBeUndefined()
    })
    it('accepts a valid interval', () => {
      const spec = pipelineTriggerToSpec('wf', { kind: 'interval', everyMs: 1000 }, 0)
      expect(spec).toMatchObject({ kind: 'interval', workflowId: 'wf', everyMs: 1000 })
    })

    it('accepts a valid duration string for `every`', () => {
      const spec = pipelineTriggerToSpec('wf', { kind: 'interval', every: '5m' }, 0)
      expect(spec).toMatchObject({
        kind: 'interval',
        workflowId: 'wf',
        everyMs: 300_000,
        every: '5m',
      })
    })

    // Regression: parseDuration THROWS on a malformed string ('5min' — the unit
    // is 'm', not 'min'). This is called uncaught during gateway-boot trigger
    // discovery and project activation, so a single typo'd `every` would crash
    // the whole workflow load instead of skipping just that trigger. It must be
    // rejected gracefully (return undefined → caller skips it), matching the
    // schedules HTTP route which catches parseDuration and returns 400.
    it('returns undefined (does not throw) for a malformed `every` duration', () => {
      expect(() =>
        pipelineTriggerToSpec('wf', { kind: 'interval', every: '5min' }, 0),
      ).not.toThrow()
      expect(pipelineTriggerToSpec('wf', { kind: 'interval', every: '5min' }, 0)).toBeUndefined()
      expect(pipelineTriggerToSpec('wf', { kind: 'interval', every: 'garbage' }, 0)).toBeUndefined()
      expect(pipelineTriggerToSpec('wf', { kind: 'interval', every: '' }, 0)).toBeUndefined()
    })

    it('accepts the canonical `cron` field', () => {
      const spec = pipelineTriggerToSpec('wf', { kind: 'cron', cron: '0 9 * * *' }, 0)
      expect(spec).toMatchObject({ kind: 'cron', workflowId: 'wf', cron: '0 9 * * *' })
    })

    // A declared trigger written in the POST /schedules shape
    // (`{ kind: 'cron', expression }`) used to yield `cron: undefined`, then threw
    // `undefined.trim()` in the parser at arm time — aborting the workflow's whole
    // trigger discovery and dropping its sibling triggers. Accept `expression` as
    // an alias.
    it('accepts `expression` as an alias for `cron`', () => {
      const spec = pipelineTriggerToSpec('wf', { kind: 'cron', expression: '* * * * *' }, 0)
      expect(spec).toMatchObject({ kind: 'cron', workflowId: 'wf', cron: '* * * * *' })
    })

    it('refuses (does not crash on) a cron trigger with neither cron nor expression', () => {
      expect(pipelineTriggerToSpec('wf', { kind: 'cron' }, 0)).toBeUndefined()
      expect(pipelineTriggerToSpec('wf', { kind: 'cron', cron: '' }, 0)).toBeUndefined()
    })
  })

  describe('TriggerCoordinator', () => {
    it('does NOT arm a tight loop for everyMs <= 0 (DoS prevented)', async () => {
      const fires: string[] = []
      const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
      c.register({ kind: 'interval', id: 't-bad', workflowId: 'wf', everyMs: -5 })
      // Without the guard this would fire ~60 times in 60ms; with it, zero.
      await new Promise((r) => setTimeout(r, 60))
      expect(fires).toHaveLength(0)
      expect(c.get('t-bad')?.lastError).toMatch(/invalid interval/i)
      await c.stop()
    })

    it('still arms valid intervals', async () => {
      const fires: string[] = []
      const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
      c.register({ kind: 'interval', id: 't-ok', workflowId: 'wf', everyMs: 20 })
      await new Promise((r) => setTimeout(r, 70))
      expect(fires.length).toBeGreaterThanOrEqual(1)
      await c.stop()
    })
  })
})
