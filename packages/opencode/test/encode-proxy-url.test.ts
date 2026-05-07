import { describe, expect, test } from 'vitest'
import { encodeProxyUrlWithToken } from '../src/client.js'

describe('encodeProxyUrlWithToken', () => {
  test('returns the proxy URL unchanged when no token is provided', () => {
    expect(encodeProxyUrlWithToken('http://127.0.0.1:14739', undefined)).toBe(
      'http://127.0.0.1:14739',
    )
    expect(encodeProxyUrlWithToken('http://127.0.0.1:14739', '')).toBe('http://127.0.0.1:14739')
  })

  test('encodes the token as the password field of the proxy URL', () => {
    const got = encodeProxyUrlWithToken('http://127.0.0.1:14739', 'run-1:step-1')
    expect(got).toMatch(/^http:\/\/token:run-1(%3A|:)step-1@127\.0\.0\.1:14739\/?$/)
  })

  test('URL-encodes special characters in the token', () => {
    const got = encodeProxyUrlWithToken('http://127.0.0.1:14739', 'a b@c/d')
    // Standard URL encoding for the password field; "@" and "/" must be escaped.
    expect(got).toContain('a%20b%40c%2Fd')
  })

  test('returns the input unchanged when the URL is unparseable', () => {
    expect(encodeProxyUrlWithToken('not a url', 'tok')).toBe('not a url')
  })
})
