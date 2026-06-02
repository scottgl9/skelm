import { createConnection } from 'node:net'
import type { AuditWriter, NetworkPolicy } from '@skelm/core'
import { afterEach, describe, expect, test } from 'vitest'
import { EgressProxy, InMemoryTokenPolicyStore } from '../../src/proxy/index.js'

// Adversarial coverage for the SSRF / cloud-metadata egress block. The proxy
// must refuse to tunnel to a metadata address (169.254.0.0/16, fd00:ec2::254) —
// the canonical credential-theft target — even when the step's networkEgress
// policy is `allow`, and whether the target is a literal IP or a hostname that
// resolves to one (DNS rebinding). An `allowMetadataEgress` opt-in restores it.

class FakeAuditWriter implements AuditWriter {
  events: Array<{ action: string; details?: Record<string, unknown> }> = []
  async write(entry: { actor: string; action: string; details?: Record<string, unknown> }) {
    this.events.push({ action: entry.action, details: entry.details })
  }
}

describe('egress-proxy metadata block (SSRF)', () => {
  let proxy: EgressProxy | null = null

  afterEach(async () => {
    if (proxy) {
      await proxy.stop()
      proxy = null
    }
  })

  async function start(opts: {
    policy: NetworkPolicy
    allowMetadataEgress?: boolean
    lookup?: (h: string) => Promise<ReadonlyArray<{ address: string }>>
  }): Promise<{ port: number; audit: FakeAuditWriter }> {
    const audit = new FakeAuditWriter()
    const tokenStore = new InMemoryTokenPolicyStore()
    tokenStore.set('run1:step1', opts.policy)
    proxy = new EgressProxy({
      port: 0,
      host: '127.0.0.1',
      tokenStore,
      auditWriter: audit,
      defaultPolicy: 'deny',
      ...(opts.allowMetadataEgress !== undefined && {
        allowMetadataEgress: opts.allowMetadataEgress,
      }),
      ...(opts.lookup !== undefined && { lookup: opts.lookup }),
    })
    await proxy.start()
    return { port: proxy.getPort(), audit }
  }

  test('blocks a literal IPv4 metadata target under an "allow" policy', async () => {
    const { port, audit } = await start({ policy: 'allow' })
    const result = await makeConnectRequest(port, '169.254.169.254:80', 'run1:step1')
    expect(result.allowed).toBe(false)
    expect(result.statusCode).toBe(403)
    const deny = audit.events.find((e) => e.action === 'network.egress:deny')
    expect(deny?.details?.reason).toBe('blocked-address')
  })

  test('blocks the IPv6 metadata literal', async () => {
    const { port } = await start({ policy: 'allow' })
    const result = await makeConnectRequest(port, '[fd00:ec2::254]:80', 'run1:step1')
    expect(result.allowed).toBe(false)
    expect(result.statusCode).toBe(403)
  })

  test('blocks a hostname that resolves to a metadata address (DNS rebinding)', async () => {
    const { port, audit } = await start({
      policy: 'allow',
      lookup: async () => [{ address: '169.254.169.254' }],
    })
    const result = await makeConnectRequest(port, 'rebind.internal:443', 'run1:step1')
    expect(result.allowed).toBe(false)
    expect(result.statusCode).toBe(403)
    const deny = audit.events.find((e) => e.action === 'network.egress:deny')
    expect(deny?.details?.reason).toBe('blocked-address')
  })

  test('allows a hostname that resolves to a public address', async () => {
    const { port, audit } = await start({
      policy: 'allow',
      lookup: async () => [{ address: '93.184.216.34' }],
    })
    const result = await makeConnectRequest(port, 'good.example:443', 'run1:step1')
    expect(result.allowed).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(audit.events.find((e) => e.action === 'network.egress:allow')).toBeDefined()
  })

  test('allowMetadataEgress opt-in permits a literal metadata target', async () => {
    const { port } = await start({ policy: 'allow', allowMetadataEgress: true })
    const result = await makeConnectRequest(port, '169.254.169.254:80', 'run1:step1')
    expect(result.allowed).toBe(true)
    expect(result.statusCode).toBe(200)
  })
})

async function makeConnectRequest(
  proxyPort: number,
  target: string,
  token: string | undefined,
): Promise<{ allowed: boolean; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxyPort, '127.0.0.1', () => {
      let request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`
      if (token) request += `Authorization: Bearer ${token}\r\n`
      request += '\r\n'
      socket.write(request)
    })
    let response = ''
    socket.on('data', (data: Buffer) => {
      response += data.toString()
      const statusLine = response.split('\r\n')[0]
      const m = statusLine.match(/HTTP\/1\.1\s+(\d+)/)
      const statusCode = m ? Number.parseInt(m[1], 10) : 0
      socket.destroy()
      resolve({ allowed: statusCode === 200, statusCode })
    })
    socket.on('error', (err) => reject(err))
    setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, 5000)
  })
}
