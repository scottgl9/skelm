import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { connect } from 'node:net'
import { EgressProxy } from '../../src/proxy/egress-proxy.js'

// Use a port unlikely to conflict with anything
const TEST_PORT = 19876

function makeProxy() {
  return new EgressProxy({ host: '127.0.0.1', port: TEST_PORT })
}

async function sendRaw(data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port: TEST_PORT }, () => {
      sock.write(data)
    })
    let response = ''
    sock.on('data', (chunk) => {
      response += chunk.toString()
      // We only need the status line — end once we have it
      if (response.includes('\r\n')) {
        sock.destroy()
        resolve(response.split('\r\n')[0])
      }
    })
    sock.on('close', () => resolve(response.split('\r\n')[0] ?? ''))
    sock.on('error', reject)
    setTimeout(() => {
      sock.destroy()
      resolve(response.split('\r\n')[0] ?? '')
    }, 2000)
  })
}

describe('EgressProxy — CONNECT enforcement', () => {
  let proxy: EgressProxy

  beforeEach(async () => {
    proxy = makeProxy()
    await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  it('denies CONNECT with no token (safe default)', async () => {
    const status = await sendRaw(
      'CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n',
    )
    expect(status).toContain('407')
  })

  it('denies CONNECT with unknown token', async () => {
    const status = await sendRaw(
      'CONNECT api.openai.com:443 HTTP/1.1\r\nProxy-Authorization: Bearer notregistered\r\n\r\n',
    )
    expect(status).toContain('407')
  })

  it('denies CONNECT when policy is deny', async () => {
    const token = EgressProxy.generateToken()
    proxy.registry.register(token, { networkEgress: 'deny' })
    const status = await sendRaw(
      `CONNECT api.openai.com:443 HTTP/1.1\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`,
    )
    expect(status).toContain('407')
  })

  it('denies CONNECT when host is not in allowHosts', async () => {
    const token = EgressProxy.generateToken()
    proxy.registry.register(token, {
      networkEgress: { allowHosts: ['api.anthropic.com'] },
    })
    const status = await sendRaw(
      `CONNECT api.openai.com:443 HTTP/1.1\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`,
    )
    expect(status).toContain('407')
  })

  it('allows CONNECT when policy is allow', async () => {
    const token = EgressProxy.generateToken()
    proxy.registry.register(token, { networkEgress: 'allow' })
    // We expect either 200 (tunnel opened) or 502 (upstream refused — that's fine,
    // it means the proxy allowed the connection attempt)
    const status = await sendRaw(
      `CONNECT 127.0.0.1:1 HTTP/1.1\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`,
    )
    expect(status).toMatch(/200|502/)
  })

  it('allows CONNECT when host is in allowHosts', async () => {
    const token = EgressProxy.generateToken()
    proxy.registry.register(token, {
      networkEgress: { allowHosts: ['127.0.0.1'] },
    })
    const status = await sendRaw(
      `CONNECT 127.0.0.1:1 HTTP/1.1\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`,
    )
    expect(status).toMatch(/200|502/)
  })
})

describe('EgressProxy.generateToken', () => {
  it('generates unique tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => EgressProxy.generateToken()))
    expect(tokens.size).toBe(100)
  })
})

describe('egressEnv helper', () => {
  it('returns empty object when proxy is not started', () => {
    // Gateway.egressEnv is tested via the gateway — here we just verify
    // the proxy URL format
    const proxy = new EgressProxy({ port: TEST_PORT + 1 })
    expect(proxy.proxyUrl).toBe(`http://127.0.0.1:${TEST_PORT + 1}`)
  })
})
