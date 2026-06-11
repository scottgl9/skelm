import { createConnection } from 'node:net'
import type { AuditWriter } from '@skelm/core'
import { afterEach, describe, expect, test } from 'vitest'
import { EgressProxy, InMemoryTokenPolicyStore } from '../../src/proxy/index.js'

// DoS limits on the egress proxy: a destination DNS lookup must not hang the
// connection, and a client streaming a headless blob must be rejected rather
// than buffered unbounded.

class FakeAuditWriter implements AuditWriter {
  async write(): Promise<void> {}
}

describe('egress-proxy DoS limits', () => {
  let proxy: EgressProxy | null = null

  afterEach(async () => {
    if (proxy) {
      await proxy.stop()
      proxy = null
    }
  })

  async function start(opts: {
    lookup?: (h: string) => Promise<ReadonlyArray<{ address: string }>>
  }): Promise<number> {
    const tokenStore = new InMemoryTokenPolicyStore()
    tokenStore.set('run1:step1', 'allow')
    proxy = new EgressProxy({
      port: 0,
      host: '127.0.0.1',
      tokenStore,
      auditWriter: new FakeAuditWriter(),
      defaultPolicy: 'deny',
      ...(opts.lookup !== undefined && { lookup: opts.lookup }),
    })
    await proxy.start()
    return proxy.getPort()
  }

  test('a failing destination DNS lookup fails closed without hanging', async () => {
    const port = await start({
      lookup: async () => {
        throw new Error('resolver down')
      },
    })
    const result = await makeConnect(port, 'good.example:443', 'run1:step1')
    expect(result.statusCode).toBe(403)
  })

  test('rejects a headless blob that exceeds the request-head cap with 431', async () => {
    const port = await start({})
    const status = await new Promise<number>((resolve, reject) => {
      const sock = createConnection(port, '127.0.0.1', () => {
        // 80 KiB with no CRLF → never a complete request line → head cap trips.
        sock.write('A'.repeat(80 * 1024))
      })
      let response = ''
      sock.on('data', (d: Buffer) => {
        response += d.toString()
        const m = response.split('\r\n')[0].match(/HTTP\/1\.1\s+(\d+)/)
        if (m) {
          sock.destroy()
          resolve(Number.parseInt(m[1], 10))
        }
      })
      sock.on('error', reject)
      setTimeout(() => {
        sock.destroy()
        reject(new Error('no response'))
      }, 5000)
    })
    expect(status).toBe(431)
  })
})

async function makeConnect(
  proxyPort: number,
  target: string,
  token: string,
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxyPort, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
      )
    })
    let response = ''
    socket.on('data', (data: Buffer) => {
      response += data.toString()
      const m = response.split('\r\n')[0].match(/HTTP\/1\.1\s+(\d+)/)
      if (m) {
        socket.destroy()
        resolve({ statusCode: Number.parseInt(m[1], 10) })
      }
    })
    socket.on('error', (err) => reject(err))
    setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, 5000)
  })
}
