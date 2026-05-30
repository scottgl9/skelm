import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileLogSink, RingBufferLogSink, TeeLogSink, redact } from '../src/logs/sink.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skelm-logs-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('redact()', () => {
  it('redacts known field names regardless of value', () => {
    const out = redact({
      level: 'info',
      message: 'request',
      fields: { Authorization: 'Bearer xyz', userId: 'u-1' },
    })
    expect(out.fields?.Authorization).toBe('[REDACTED]')
    expect(out.fields?.userId).toBe('u-1')
  })

  it('redacts secret-shaped values inside the message text', () => {
    const out = redact({
      level: 'info',
      message: 'using sk-test_12345_abcdef and ghp_ABCDEFGHIJKLMNOPQRST',
    })
    expect(out.message).not.toContain('sk-test_12345')
    expect(out.message).not.toContain('ghp_ABCDEFGHIJKLMNOPQRST')
    expect(out.message).toMatch(/\[REDACTED\]/)
  })

  it('walks nested fields', () => {
    const out = redact({
      level: 'info',
      message: 'r',
      fields: { headers: { Cookie: 'session=abc', Accept: 'json' } },
    })
    expect((out.fields?.headers as Record<string, string>).Cookie).toBe('[REDACTED]')
    expect((out.fields?.headers as Record<string, string>).Accept).toBe('json')
  })

  // Regression: arrays were skipped entirely, so a secret-shaped string inside
  // a list (e.g. a logged command argv or a header list) leaked verbatim.
  it('redacts secret-shaped values inside array elements', () => {
    const out = redact({
      level: 'info',
      message: 'spawn',
      fields: { argv: ['curl', '-H', 'Authorization: Bearer sk-test_1234567890abcdef'] },
    })
    const argv = out.fields?.argv as string[]
    expect(argv[0]).toBe('curl')
    expect(argv[2]).not.toContain('sk-test_1234567890abcdef')
    expect(argv[2]).toMatch(/\[REDACTED\]/)
  })

  it('redacts secret-named fields inside arrays of objects', () => {
    const out = redact({
      level: 'info',
      message: 'batch',
      fields: { requests: [{ url: '/a', token: 'super-secret' }, { url: '/b' }] },
    })
    const reqs = out.fields?.requests as Array<Record<string, unknown>>
    expect(reqs[0].token).toBe('[REDACTED]')
    expect(reqs[0].url).toBe('/a')
    expect(reqs[1].url).toBe('/b')
  })

  it('redacts secrets in nested arrays (array of arrays)', () => {
    const out = redact({
      level: 'info',
      message: 'm',
      fields: { rows: [['ok', 'ghp_ABCDEFGHIJKLMNOPQRST']] },
    })
    const rows = out.fields?.rows as string[][]
    expect(rows[0][1]).not.toContain('ghp_ABCDEFGHIJKLMNOPQRST')
    expect(rows[0][1]).toMatch(/\[REDACTED\]/)
  })
})

describe('RingBufferLogSink', () => {
  it('writes and returns recent entries in oldest-to-newest order', () => {
    const s = new RingBufferLogSink(8)
    for (let i = 0; i < 5; i++) s.write({ level: 'info', message: `m-${i}` })
    expect(s.recent().map((e) => e.message)).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4'])
  })

  it('drops the oldest entries when capacity is exceeded', () => {
    const s = new RingBufferLogSink(3)
    for (let i = 0; i < 5; i++) s.write({ level: 'info', message: `m-${i}` })
    expect(s.recent().map((e) => e.message)).toEqual(['m-2', 'm-3', 'm-4'])
  })

  it('redacts entries on write', () => {
    const s = new RingBufferLogSink(4)
    s.write({ level: 'info', message: 'leaked sk-private_AAAAAAAAAAAAAAAA value' })
    const [entry] = s.recent()
    expect(entry?.message).toContain('[REDACTED]')
  })

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBufferLogSink(0)).toThrow(/>= 1/)
  })
})

describe('FileLogSink', () => {
  it('appends JSON-Lines and redacts secrets', async () => {
    const path = join(dir, 'gateway.log')
    const s = new FileLogSink(path)
    await s.write({ level: 'info', message: 'first' })
    await s.write({
      level: 'warn',
      message: 'with token',
      fields: { token: 'super-secret' },
    })
    const raw = await fs.readFile(path, 'utf8')
    const lines = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[1].fields.token).toBe('[REDACTED]')
  })

  it('serializes concurrent writes — every line is intact JSON', async () => {
    const path = join(dir, 'concurrent.log')
    const s = new FileLogSink(path)
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => s.write({ level: 'info', message: `m-${i}` })),
    )
    const raw = await fs.readFile(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(50)
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow()
    }
  })
})

describe('TeeLogSink', () => {
  it('fans out to every sink', async () => {
    const ring = new RingBufferLogSink(4)
    const path = join(dir, 'tee.log')
    const file = new FileLogSink(path)
    const tee = new TeeLogSink([ring, file])
    await tee.write({ level: 'info', message: 'hi' })
    expect(ring.recent()[0]?.message).toBe('hi')
    const raw = await fs.readFile(path, 'utf8')
    expect(raw.trim()).toMatch(/"hi"/)
  })
})
