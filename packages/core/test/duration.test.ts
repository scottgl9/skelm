import { describe, expect, it } from 'vitest'
import { code, parseDuration, pipeline } from '../src/index.js'

describe('parseDuration', () => {
  it('parses supported duration suffixes', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('5s')).toBe(5_000)
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('2d')).toBe(172_800_000)
  })

  it('throws on invalid duration strings', () => {
    expect(() => parseDuration('soon')).toThrow(/invalid duration/i)
  })

  it('rejects durations past the 30d cap (and prevents Number overflow)', () => {
    // 999999999999999d resolves to 8.6e22 ms — past Number.MAX_SAFE_INTEGER.
    // A trigger built with the raw value would never fire; the parser must
    // refuse rather than silently register an unusable interval.
    expect(() => parseDuration('999999999999999d')).toThrow(/out of supported range/i)
    expect(() => parseDuration('31d')).toThrow(/out of supported range/i)
  })

  it('rejects zero-length durations', () => {
    expect(() => parseDuration('0s')).toThrow(/out of supported range/i)
    expect(() => parseDuration('0ms')).toThrow(/out of supported range/i)
  })

  it('accepts the boundary 30d exactly', () => {
    expect(parseDuration('30d')).toBe(30 * 86_400_000)
  })
})

describe('interval trigger duration normalization', () => {
  it('resolves every to everyMs at pipeline load time', () => {
    const flow = pipeline({
      id: 'duration-trigger',
      triggers: [{ kind: 'interval', every: '15m' }],
      steps: [code({ id: 'noop', run: () => undefined })],
    })

    expect(flow.triggers).toEqual([{ kind: 'interval', every: '15m', everyMs: 900_000 }])
  })

  it('prefers everyMs when both everyMs and every are set', () => {
    const flow = pipeline({
      id: 'duration-trigger-precedence',
      triggers: [{ kind: 'interval', everyMs: 250, every: '15m' }],
      steps: [code({ id: 'noop', run: () => undefined })],
    })

    expect(flow.triggers).toEqual([{ kind: 'interval', everyMs: 250, every: '15m' }])
  })

  it('throws for unparseable every values during pipeline construction', () => {
    expect(() =>
      pipeline({
        id: 'duration-trigger-invalid',
        triggers: [{ kind: 'interval', every: 'eventually' }],
        steps: [code({ id: 'noop', run: () => undefined })],
      }),
    ).toThrow(/invalid duration/i)
  })
})
