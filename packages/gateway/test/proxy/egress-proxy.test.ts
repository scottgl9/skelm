import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, createConnection, type Socket } from 'node:net'
import { EgressProxy, InMemoryTokenPolicyStore } from '../../src/proxy/index.js'
import type { AuditWriter, NetworkPolicy } from '@skelm/core'

// Fake audit writer for testing
class FakeAuditWriter implements AuditWriter {
  events: Array<{ actor: string; action: string; details?: Record<string, unknown> }> = []

  async write(entry: { actor: string; action: string; details?: Record<string, unknown> }): Promise<void> {
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

    test('emits audit event with unknown runId/stepId', async () => {
      const port = await startProxyWithPolicy('allow')
      await makeConnectRequest(port, 'api.openai.com:443', 'unknown:token')

      expect(auditWriter.events.length).toBe(1)
      expect(auditWriter.events[0].details?.runId).toBe('unknown')
      expect(auditWriter.events[0].details?.stepId).toBe('token')
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
      await new Promise<void>((resolve) => testHttpServer?.listen(testHttpPort, '127.0.0.1', resolve))

      const port = await startProxyWithPolicy('allow')

      // Make a CONNECT request and verify tunnel works
      const result = await makeConnectRequest(port, `127.0.0.1:${testHttpPort}:443`, 'run1:step1')
      expect(result.allowed).toBe(true)
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
        const statusCode = statusCodeMatch ? parseInt(statusCodeMatch[1], 10) : 0
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

function createNetServer() {
  return createNetServer()
}
