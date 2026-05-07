import { describe, expect, test } from 'vitest'
import {
  InMemoryTokenPolicyStore,
  type NetworkPolicy,
  checkHostPolicy,
  extractHostnameFromConnectTarget,
  extractHostnameFromHostHeader,
} from '../../src/proxy/index.js'

describe('egress-policy', () => {
  describe('checkHostPolicy', () => {
    test('deny policy rejects all hosts', () => {
      const result = checkHostPolicy('deny', 'api.openai.com')
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('egress-denied')
    })

    test('allow policy permits all hosts', () => {
      const result = checkHostPolicy('allow', 'api.openai.com')
      expect(result.allowed).toBe(true)
      expect(result.reason).toBeUndefined()
    })

    test('allowHosts policy permits matching hosts', () => {
      const policy: NetworkPolicy = { allowHosts: ['api.openai.com', 'api.anthropic.com'] }
      const result = checkHostPolicy(policy, 'api.openai.com')
      expect(result.allowed).toBe(true)
      expect(result.reason).toBeUndefined()
    })

    test('allowHosts policy rejects non-matching hosts', () => {
      const policy: NetworkPolicy = { allowHosts: ['api.openai.com'] }
      const result = checkHostPolicy(policy, 'evil.com')
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('not-in-allowlist')
    })

    test('allowHosts policy is exact match', () => {
      const policy: NetworkPolicy = { allowHosts: ['api.openai.com'] }
      const result = checkHostPolicy(policy, 'api.openai.com.evil.com')
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('not-in-allowlist')
    })
  })

  describe('extractHostnameFromConnectTarget', () => {
    test('extracts hostname from hostname:port', () => {
      expect(extractHostnameFromConnectTarget('api.openai.com:443')).toBe('api.openai.com')
    })

    test('extracts hostname from hostname without port', () => {
      expect(extractHostnameFromConnectTarget('api.openai.com')).toBe('api.openai.com')
    })

    test('handles IPv4 addresses', () => {
      expect(extractHostnameFromConnectTarget('192.168.1.1:8080')).toBe('192.168.1.1')
    })

    test('handles IPv6 addresses', () => {
      expect(extractHostnameFromConnectTarget('[::1]:8080')).toBe('[::1]')
    })
  })

  describe('extractHostnameFromHostHeader', () => {
    test('extracts hostname from hostname:port', () => {
      expect(extractHostnameFromHostHeader('api.openai.com:443')).toBe('api.openai.com')
    })

    test('extracts hostname from hostname without port', () => {
      expect(extractHostnameFromHostHeader('api.openai.com')).toBe('api.openai.com')
    })

    test('handles IPv4 addresses', () => {
      expect(extractHostnameFromHostHeader('192.168.1.1:8080')).toBe('192.168.1.1')
    })
  })

  describe('InMemoryTokenPolicyStore', () => {
    test('stores and retrieves policies', () => {
      const store = new InMemoryTokenPolicyStore()
      const policy: NetworkPolicy = { allowHosts: ['api.openai.com'] }

      store.set('run1:step1', policy)
      expect(store.get('run1:step1')).toBe(policy)
    })

    test('returns undefined for unknown tokens', () => {
      const store = new InMemoryTokenPolicyStore()
      expect(store.get('unknown')).toBeUndefined()
    })

    test('deletes policies', () => {
      const store = new InMemoryTokenPolicyStore()
      const policy: NetworkPolicy = { allowHosts: ['api.openai.com'] }

      store.set('run1:step1', policy)
      store.delete('run1:step1')
      expect(store.get('run1:step1')).toBeUndefined()
    })
  })
})
