import { describe, expect, it } from 'vitest'
import { REDACTED, redact } from '../src/redact.js'

describe('redact', () => {
  it('returns undefined for undefined input', () => {
    expect(redact(undefined)).toBeUndefined()
  })

  it('leaves benign text untouched', () => {
    expect(redact('connection ok in 12ms')).toBe('connection ok in 12ms')
  })

  it('redacts token= assignments', () => {
    const value = ['abcd', 'efgh', 'ijkl'].join('')
    expect(redact(`token=${value}xyz`)).toContain(REDACTED)
  })

  it('redacts a bearer header', () => {
    const value = ['AAAA', 'BBBB', 'CCCC'].join('')
    expect(redact(`Authorization: Bearer ${value}`)).not.toContain(value)
  })

  it('redacts a slack-style prefixed token', () => {
    const value = ['xoxb', '1111111111', 'ABCDEFGHIJKL'].join('-')
    expect(redact(`got ${value}`)).not.toContain(value)
  })

  it('redacts a long high-entropy blob', () => {
    const value = 'A'.repeat(30)
    expect(redact(`val ${value}`)).not.toContain(value)
  })
})
