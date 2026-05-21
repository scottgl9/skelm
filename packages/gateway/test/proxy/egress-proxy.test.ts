import { createServer as createHttpServer } from 'node:http'
import { type Socket, createConnection, createServer as createNetServer } from 'node:net'
import type { AuditWriter, NetworkPolicy } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { EgressProxy, InMemoryTokenPolicyStore } from '../../src/proxy/index.js'

// Fake audit writer for testing
class FakeAuditWriter implements AuditWriter {
  events: Array<{ actor: string; action: string; details?: Record<string, unknown> }> = []

  async write(entry: {
    actor: string
    action: string
    details?: Record<string, unknown>
  }): Promise<void> {
    this.events.push({ actor: entry.actor, action: entry.action, details: entry.details })
  }
}

describe('egress-proxy', () => {
  let proxy: EgressProxy | null = null
  let auditWriter: FakeAuditWriter
  let tokenStore: InMemoryTokenPolicyStore
  let testHttpServer: ReturnType<typeof createHttpServer> | null = null
  let testHttpPort = 0

  beforeEach(() => {
    auditWriter = new FakeAuditWriter()
    tokenStore = new InMemoryTokenPolicyStore()
  })

  afterEach(async () => {
    if (proxy) {
      await proxy.stop()
      proxy = null
    }
    if (testHttpServer) {
      await new Promise<void>((resolve) => {
        testHttpServer?.close(() => resolve())
      })
      testHttpServer = null
    }
  })

  async function startProxyWithPolicy(policy: NetworkPolicy) {
    tokenStore.set('run1:step1', policy)
    proxy = new EgressProxy({
      port: 0, // Let OS assign free port
      host: '127.0.0.1',
      tokenStore,
      auditWriter,
      defaultPolicy: 'deny',
    })
    await proxy.start()
    return proxy.getPort()
  }

  describe('default deny policy', () => {
    test('rejects CONNECT requests when no token is provided', async () => {
      const port = await startProxyWithPolicy('deny')

      const result = await makeConnectRequest(port, 'api.openai.com:443', undefined)
      expect(result.allowed).toBe(false)
      expect(result.statusCode).toBe(403)
    })

    test('rejects CONNECT requests when token has deny policy', async () => {
      const port = await startProxyWithPolicy('deny')

      const result = await makeConnectRequest(port, 'api.openai.com:443', 'run1:step1')
      expect(result.allowed).toBe(false)
      expect(result.statusCode).toBe(403)
    })

    test('emits audit event for denied request', async () => {
      const port = await startProxyWithPolicy('deny')
      await makeConnectRequest(port, 'api.openai.com:443', 'run1:step1')

      expect(auditWriter.events.length).toBe(1)
      expect(auditWriter.events[0].action).toBe('network.egress:deny')
      expect(auditWriter.events[0].details?.host).toBe('api.openai.com')
      expect(auditWriter.events[0].details?.decision).toBe('deny')
    })
  })

  describe('allow policy', () => {
    test('allows CONNECT requests when policy is allow', async () => {
      const port = await startProxyWithPolicy('allow')

      const result = await makeConnectRequest(port, 'api.openai.com:443', 'run1:step1')
      expect(result.allowed).toBe(true)
      expect(result.statusCode).toBe(200)
    })

    test('emits audit event for allowed request', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'api.openai.com:443', 'run1:step1')

      expect(auditWriter.events.length).toBe(1)
      expect(auditWriter.events[0].action).toBe('network.egress:allow')
      expect(auditWriter.events[0].details?.host).toBe('api.openai.com')
      expect(auditWriter.events[0].details?.decision).toBe('allow')
    })
  })

  describe('allowHosts policy', () => {
    test('allows CONNECT requests to allowed hosts', async () => {
      const port = await startProxyWithPolicy({ allowHosts: ['api.openai.com'] })

      const result = await makeConnectRequest(port, 'api.openai.com:443', 'run1:step1')
      expect(result.allowed).toBe(true)
      expect(result.statusCode).toBe(200)
    })

    test('rejects CONNECT requests to non-allowed hosts', async () => {
      const port = await startProxyWithPolicy({ allowHosts: ['api.openai.com'] })

      const result = await makeConnectRequest(port, 'evil.com:443', 'run1:step1')
      expect(result.allowed).toBe(false)
      expect(result.statusCode).toBe(403)
    })

    test('emits audit event for allowed host', async () => {
      const port = await startProxyWithPolicy({ allowHosts: ['api.openai.com'] })
      await makeConnectRequest(port, 'api.openai.com:443', 'run1:step1')

      expect(auditWriter.events.length).toBe(1)
      expect(auditWriter.events[0].details?.host).toBe('api.openai.com')
      expect(auditWriter.events[0].details?.decision).toBe('allow')
    })

    test('emits audit event for denied host', async () => {
      const port = await startProxyWithPolicy({ allowHosts: ['api.openai.com'] })
      await makeConnectRequest(port, 'evil.com:443', 'run1:step1')

      expect(auditWriter.events.length).toBe(1)
      expect(auditWriter.events[0].details?.host).toBe('evil.com')
      expect(auditWriter.events[0].details?.decision).toBe('deny')
      expect(auditWriter.events[0].details?.reason).toBe('not-in-allowlist')
    })
  })

  describe('unknown token handling', () => {
    test('applies default deny policy for unknown tokens', async () => {
      const port = await startProxyWithPolicy('allow')

      // Use a different token that wasn't registered
      const result = await makeConnectRequest(port, 'api.openai.com:443', 'unknown:token')
      expect(result.allowed).toBe(false)
      expect(result.statusCode).toBe(403)
    })

    test('emits audit event preserving the literal runId/stepId parsed from a well-formed token', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'api.openai.com:443', 'unknown:token')

      expect(auditWriter.events.length).toBe(1)
      expect(auditWriter.events[0].details?.runId).toBe('unknown')
      expect(auditWriter.events[0].details?.stepId).toBe('token')
    })

    test('omits runId/stepId in audit event when no auth header is sent (#173)', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'api.openai.com:443', undefined)

      expect(auditWriter.events.length).toBe(1)
      const details = auditWriter.events[0].details
      expect(details).toBeDefined()
      expect(details).not.toHaveProperty('runId')
      expect(details).not.toHaveProperty('stepId')
      // The other forensic fields still land:
      expect(details?.tokenPresent).toBe(false)
      expect(details?.reason).toBe('unknown-token')
    })

    test('omits runId/stepId for malformed (no-colon) tokens (#173)', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'api.openai.com:443', 'malformedtoken')

      expect(auditWriter.events.length).toBe(1)
      const details = auditWriter.events[0].details
      expect(details).not.toHaveProperty('stepId')
      // For a colon-less token we keep the runId (it's a literal identifier
      // the caller supplied); stepId has nowhere to come from.
      expect(details?.runId).toBe('malformedtoken')
    })
  })

  describe('tunnel forwarding', () => {
    test('forwards data through tunnel when allowed', async () => {
      // Start a test HTTP server
      testHttpPort = await pickFreePort()
      testHttpServer = createHttpServer((req, res) => {
        res.writeHead(200)
        res.end('OK')
      })
      await new Promise<void>((resolve) =>
        testHttpServer?.listen(testHttpPort, '127.0.0.1', resolve),
      )

      const port = await startProxyWithPolicy('allow')

      // Make a CONNECT request and verify tunnel works
      const result = await makeConnectRequest(port, `127.0.0.1:${testHttpPort}:443`, 'run1:step1')
      expect(result.allowed).toBe(true)
    })
  })

  describe('Proxy-Authorization: Basic', () => {
    test('accepts a Basic-encoded token (token:<egressToken>) and resolves the per-step policy', async () => {
      const port = await startProxyWithPolicy('allow')
      // Encode 'token:run1:step1' as Basic auth — this is what standard HTTP
      // clients send when they see http://token:run1:step1@host:port.
      const basic = Buffer.from('token:run1:step1', 'utf8').toString('base64')
      const result = await makeConnectRequestRaw(port, 'example.com:443', [
        `Proxy-Authorization: Basic ${basic}`,
      ])
      expect(result.allowed).toBe(true)
      expect(result.statusCode).toBe(200)
    })

    test('Basic with wrong password (unknown token) falls back to default-deny', async () => {
      const port = await startProxyWithPolicy('allow')
      const basic = Buffer.from('token:does-not-exist', 'utf8').toString('base64')
      const result = await makeConnectRequestRaw(port, 'example.com:443', [
        `Proxy-Authorization: Basic ${basic}`,
      ])
      expect(result.allowed).toBe(false)
      expect(result.statusCode).toBe(403)
    })
  })

  describe('audit reason', () => {
    test('omits reason on allowed decisions (no more spurious unknown-token noise)', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'example.com:443', 'run1:step1')
      const allow = auditWriter.events.find((e) => e.action === 'network.egress:allow')
      expect(allow).toBeDefined()
      expect(allow?.details?.reason).toBeUndefined()
    })

    test('preserves the policy reason on denied decisions', async () => {
      const port = await startProxyWithPolicy({ allowHosts: ['example.com'] })
      await makeConnectRequest(port, 'api.github.com:443', 'run1:step1')
      const deny = auditWriter.events.find((e) => e.action === 'network.egress:deny')
      expect(deny).toBeDefined()
      expect(deny?.details?.reason).toBe('not-in-allowlist')
    })
  })

  describe('token format', () => {
    test('preserves stepIds that contain colons', async () => {
      // token = "run-uuid-123:cohort:a"  — split-on-first-colon should yield
      // runId="run-uuid-123", stepId="cohort:a".
      const policy: NetworkPolicy = 'allow'
      tokenStore.set('run-uuid-123:cohort:a', policy)
      proxy = new EgressProxy({
        port: 0,
        host: '127.0.0.1',
        tokenStore,
        auditWriter,
        defaultPolicy: 'deny',
      })
      await proxy.start()
      const port = proxy.getPort()
      const result = await makeConnectRequest(port, 'example.com:443', 'run-uuid-123:cohort:a')
      expect(result.allowed).toBe(true)
      const allow = auditWriter.events.find((e) => e.action === 'network.egress:allow')
      expect(allow?.details?.runId).toBe('run-uuid-123')
      expect(allow?.details?.stepId).toBe('cohort:a')
    })
  })

  describe('untokened-deny observability (F010)', () => {
    test('records source remoteAddress/remotePort for untokened denies', async () => {
      const port = await startProxyWithPolicy('allow')
      // Make a CONNECT with no Authorization header at all → unknown-token deny.
      await makeConnectRequest(port, 'example.com:443', undefined)
      const deny = auditWriter.events.find((e) => e.action === 'network.egress:deny')
      expect(deny).toBeDefined()
      const source = deny?.details?.source as { address?: string; port?: number } | undefined
      expect(source?.address).toMatch(/^(?:127\.0\.0\.1|::ffff:127\.0\.0\.1)$/)
      expect(typeof source?.port).toBe('number')
      expect(source?.port).toBeGreaterThan(0)
    })

    test('reports tokenPresent: false when no auth header was sent', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'example.com:443', undefined)
      const deny = auditWriter.events.find((e) => e.action === 'network.egress:deny')
      expect(deny?.details?.tokenPresent).toBe(false)
      expect(deny?.details?.reason).toBe('unknown-token')
    })

    test('classifies a well-formed-but-unknown token as unknown-token (was: misclassified as egress-denied)', async () => {
      // Operationally identical to a stale subprocess that's holding a token
      // the gateway has already unregistered. Pre-fix this misclassified as
      // egress-denied and the counter never advanced.
      const port = await startProxyWithPolicy('allow')
      // Bearer token that the proxy can extract but won't find in the store.
      await makeConnectRequest(port, 'example.com:443', 'made-up-token')
      const deny = auditWriter.events.find((e) => e.action === 'network.egress:deny')
      expect(deny?.details?.tokenPresent).toBe(true)
      expect(deny?.details?.reason).toBe('unknown-token')
      expect((deny?.details as { unknownTokenDenials?: number })?.unknownTokenDenials).toBe(1)
      // runId / stepId still extracted from the (parseable) bearer string
      // so an operator can correlate the offending subprocess if the token
      // was once issued and is now stale.
      expect(deny?.details?.runId).toBe('made-up-token')
    })

    test('cumulative unknownTokenDenials counter increments per untokened deny', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'example.com:443', undefined)
      await makeConnectRequest(port, 'example.com:443', undefined)
      await makeConnectRequest(port, 'example.com:443', undefined)
      const denies = auditWriter.events.filter((e) => e.action === 'network.egress:deny')
      const counts = denies.map(
        (e) => (e.details as { unknownTokenDenials?: number })?.unknownTokenDenials,
      )
      expect(counts).toEqual([1, 2, 3])
    })

    test('counter increments for both no-token and stale-token denies (mixed)', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'example.com:443', undefined) // no token
      await makeConnectRequest(port, 'example.com:443', 'stale-1') // unknown token
      await makeConnectRequest(port, 'example.com:443', undefined) // no token
      await makeConnectRequest(port, 'example.com:443', 'stale-2') // unknown token
      const denies = auditWriter.events.filter((e) => e.action === 'network.egress:deny')
      const counts = denies.map(
        (e) => (e.details as { unknownTokenDenials?: number })?.unknownTokenDenials,
      )
      expect(counts).toEqual([1, 2, 3, 4])
      // Every entry classified as unknown-token regardless of header presence.
      expect(denies.every((e) => e.details?.reason === 'unknown-token')).toBe(true)
    })

    test('does NOT emit unknownTokenDenials counter for non-unknown-token denies', async () => {
      // allowHosts policy → host not in list → policy reason is "not-in-allowlist", not "unknown-token".
      const port = await startProxyWithPolicy({ allowHosts: ['example.com'] })
      await makeConnectRequest(port, 'api.github.com:443', 'run1:step1')
      const deny = auditWriter.events.find((e) => e.action === 'network.egress:deny')
      expect(deny?.details?.reason).toBe('not-in-allowlist')
      expect(
        (deny?.details as { unknownTokenDenials?: number })?.unknownTokenDenials,
      ).toBeUndefined()
    })

    test('source is also captured on allow decisions', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'example.com:443', 'run1:step1')
      const allow = auditWriter.events.find((e) => e.action === 'network.egress:allow')
      expect(allow?.details?.source).toBeDefined()
    })
  })
})

// Helper to make a CONNECT request
async function makeConnectRequest(
  proxyPort: number,
  target: string,
  token: string | undefined,
): Promise<{ allowed: boolean; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxyPort, '127.0.0.1', () => {
      let request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`
      if (token) {
        request += `Authorization: Bearer ${token}\r\n`
      }
      request += '\r\n'
      socket.write(request)
    })

    let response = ''
    socket.on('data', (data: Buffer) => {
      response += data.toString()
      const lines = response.split('\r\n')
      if (lines.length >= 1) {
        const statusLine = lines[0]
        const statusCodeMatch = statusLine.match(/HTTP\/1\.1\s+(\d+)/)
        const statusCode = statusCodeMatch ? Number.parseInt(statusCodeMatch[1], 10) : 0
        socket.destroy()
        resolve({
          allowed: statusCode === 200,
          statusCode,
        })
      }
    })

    socket.on('error', (err) => {
      reject(err)
    })

    setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, 5000)
  })
}

// Like makeConnectRequest but lets the caller pass arbitrary header lines
// (e.g. Proxy-Authorization: Basic <...>).
async function makeConnectRequestRaw(
  proxyPort: number,
  target: string,
  extraHeaders: string[],
): Promise<{ allowed: boolean; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxyPort, '127.0.0.1', () => {
      let request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`
      for (const h of extraHeaders) request += `${h}\r\n`
      request += '\r\n'
      socket.write(request)
    })

    let response = ''
    socket.on('data', (data: Buffer) => {
      response += data.toString()
      const lines = response.split('\r\n')
      if (lines.length >= 1) {
        const statusLine = lines[0]
        const statusCodeMatch = statusLine.match(/HTTP\/1\.1\s+(\d+)/)
        const statusCode = statusCodeMatch ? Number.parseInt(statusCodeMatch[1], 10) : 0
        socket.destroy()
        resolve({ allowed: statusCode === 200, statusCode })
      }
    })

    socket.on('error', (err) => reject(err))
    setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, 5000)
  })
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('failed to bind ephemeral port'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}
