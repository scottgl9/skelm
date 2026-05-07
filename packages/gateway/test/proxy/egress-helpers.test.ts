import { describe, expect, test } from 'vitest'
import { rewriteRequestLineToOriginForm } from '../../src/proxy/egress-proxy.js'

describe('rewriteRequestLineToOriginForm', () => {
  test('strips http:// scheme + host, leaving origin-form path', () => {
    expect(rewriteRequestLineToOriginForm('GET http://example.com/foo HTTP/1.1')).toBe(
      'GET /foo HTTP/1.1',
    )
  })

  test('strips https:// scheme + host', () => {
    expect(rewriteRequestLineToOriginForm('PUT https://example.com:8443/x?y=1 HTTP/1.1')).toBe(
      'PUT /x?y=1 HTTP/1.1',
    )
  })

  test('synthesizes "/" when the absolute URI has no path', () => {
    expect(rewriteRequestLineToOriginForm('GET http://example.com HTTP/1.1')).toBe('GET / HTTP/1.1')
  })

  test('leaves origin-form requests untouched', () => {
    expect(rewriteRequestLineToOriginForm('GET /foo HTTP/1.1')).toBe('GET /foo HTTP/1.1')
  })

  test('handles arbitrary HTTP methods (PUT, DELETE, PATCH, …)', () => {
    expect(rewriteRequestLineToOriginForm('DELETE http://example.com/x HTTP/1.1')).toBe(
      'DELETE /x HTTP/1.1',
    )
    expect(rewriteRequestLineToOriginForm('PATCH http://example.com/x HTTP/1.1')).toBe(
      'PATCH /x HTTP/1.1',
    )
  })

  test('returns input unchanged for malformed request lines', () => {
    expect(rewriteRequestLineToOriginForm('GET')).toBe('GET')
    expect(rewriteRequestLineToOriginForm('')).toBe('')
  })
})
