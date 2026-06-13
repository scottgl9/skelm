import { describe, expect, it } from 'vitest'
import { redactString, redactToDetail, redactValue } from '../src/redact.js'

const TOKEN = ['sk', 'live', '0123456789ABCDEFabcdef'].join('-')
const GH = ['ghp', '0123456789abcdefABCDEF'].join('_')

describe('redactString', () => {
  it('redacts bearer tokens but keeps the scheme', () => {
    const out = redactString(`Authorization: Bearer ${GH}`)
    expect(out).not.toContain(GH)
    expect(out.toLowerCase()).toContain('bearer')
    expect(out).toContain('[redacted]')
  })

  it('redacts key=value secret pairs', () => {
    const out = redactString(`failed: token=${TOKEN} while connecting`)
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('token=')
  })

  it('redacts bare provider key prefixes', () => {
    const out = redactString(`leaked ${TOKEN} in trace`)
    expect(out).not.toContain(TOKEN)
  })

  it('leaves non-secret text untouched', () => {
    expect(redactString('step fetch failed: connection refused')).toBe(
      'step fetch failed: connection refused',
    )
  })
})

describe('redactValue', () => {
  it('drops values under secret-shaped keys', () => {
    const out = redactValue({
      secret: TOKEN,
      apiKey: TOKEN,
      note: 'ok',
      nested: { password: TOKEN },
    })
    const s = JSON.stringify(out)
    expect(s).not.toContain(TOKEN)
    expect(s).toContain('"note":"ok"')
  })

  it('scrubs secrets inside string leaves', () => {
    const out = redactValue({ message: `bearer ${GH} denied` })
    expect(JSON.stringify(out)).not.toContain(GH)
  })

  it('bounds recursion depth', () => {
    let deep: Record<string, unknown> = { token: TOKEN }
    for (let i = 0; i < 20; i++) deep = { child: deep }
    expect(JSON.stringify(redactValue(deep))).not.toContain(TOKEN)
  })
})

describe('redactToDetail', () => {
  it('produces a bounded one-line redacted string', () => {
    const detail = redactToDetail({ error: `token=${TOKEN}`, padding: 'x'.repeat(500) })
    expect(detail).not.toContain(TOKEN)
    expect(detail.length).toBeLessThanOrEqual(240)
    expect(detail).not.toContain('\n')
  })
})
