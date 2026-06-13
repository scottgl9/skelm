import { describe, expect, it } from 'vitest'
import { redactHeaders, redactUrl } from '../src/redact.js'

describe('redactHeaders()', () => {
  it('redacts Authorization header', () => {
    const result = redactHeaders({ Authorization: 'Bearer secret' })
    expect(result.Authorization).toBe('[REDACTED]')
  })

  it('redacts x-api-key header case-insensitively', () => {
    expect(redactHeaders({ 'x-api-key': 'key123' })['x-api-key']).toBe('[REDACTED]')
    expect(redactHeaders({ 'X-Api-Key': 'key123' })['X-Api-Key']).toBe('[REDACTED]')
  })

  it('redacts proxy-authorization header', () => {
    expect(redactHeaders({ 'proxy-authorization': 'Basic abc' })['proxy-authorization']).toBe(
      '[REDACTED]',
    )
  })

  it('redacts cookie and set-cookie headers', () => {
    expect(redactHeaders({ cookie: 'session=abc' }).cookie).toBe('[REDACTED]')
    expect(redactHeaders({ 'set-cookie': 'session=abc' })['set-cookie']).toBe('[REDACTED]')
  })

  it('passes through non-sensitive headers unchanged', () => {
    const result = redactHeaders({
      'content-type': 'application/json',
      accept: 'application/json',
      'x-request-id': 'req-123',
    })
    expect(result['content-type']).toBe('application/json')
    expect(result.accept).toBe('application/json')
    expect(result['x-request-id']).toBe('req-123')
  })

  it('returns empty object for empty input', () => {
    expect(redactHeaders({})).toEqual({})
  })

  it('does not mutate the input object', () => {
    const input = { Authorization: 'Bearer tok' }
    redactHeaders(input)
    expect(input.Authorization).toBe('Bearer tok')
  })
})

describe('redactUrl()', () => {
  it('strips query parameters from the URL', () => {
    expect(redactUrl('https://api.example.com/data?token=secret&foo=bar')).toBe(
      'https://api.example.com/data',
    )
  })

  it('preserves scheme, host, and path', () => {
    expect(redactUrl('https://api.example.com/v1/items')).toBe('https://api.example.com/v1/items')
  })

  it('returns <invalid-url> for unparseable input', () => {
    expect(redactUrl('not a url')).toBe('<invalid-url>')
  })

  it('strips hash fragments', () => {
    const result = redactUrl('https://api.example.com/page#section')
    expect(result).not.toContain('#section')
  })
})
