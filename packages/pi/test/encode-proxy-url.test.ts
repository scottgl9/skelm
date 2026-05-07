import { describe, expect, test } from 'vitest'
import { encodeProxyUrlWithToken } from '../src/rpc-client.js'

describe('pi/encodeProxyUrlWithToken', () => {
  test('returns the URL unchanged when token is empty/undefined', () => {
    expect(encodeProxyUrlWithToken('http://127.0.0.1:14739', undefined)).toBe(
      'http://127.0.0.1:14739',
    )
    expect(encodeProxyUrlWithToken('http://127.0.0.1:14739', '')).toBe('http://127.0.0.1:14739')
  })

  test('encodes the token as the URL password', () => {
    const got = encodeProxyUrlWithToken('http://127.0.0.1:14739', 'run-1:step-1')
    expect(got).toMatch(/^http:\/\/token:run-1(%3A|:)step-1@127\.0\.0\.1:14739\/?$/)
  })

  test('escapes special characters in the token', () => {
    const got = encodeProxyUrlWithToken('http://127.0.0.1:14739', 'a@b/c')
    expect(got).toContain('a%40b%2Fc')
  })
})
