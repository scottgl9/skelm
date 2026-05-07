/**
 * Embedded CONNECT proxy for skelm gateway egress enforcement.
 *
 * ## How it works
 *
 * Every agent subprocess is spawned with:
 *   HTTP_PROXY=http://127.0.0.1:<proxyPort>
 *   HTTPS_PROXY=http://127.0.0.1:<proxyPort>
 *   SKELM_EGRESS_TOKEN=<per-step-unique-token>
 *
 * Node.js `http`/`https`, `fetch`, and every SDK that wraps them honour
 * these env vars automatically.
 *
 * For HTTPS the client sends a CONNECT request before TLS:
 *   CONNECT api.openai.com:443 HTTP/1.1
 *   Proxy-Authorization: Bearer <token>
 *
 * The proxy reads the hostname in plaintext (no TLS interception needed),
 * looks up the step policy via the token, and either tunnels the connection
 * or closes it with a 407 response.
 *
 * For plain HTTP the proxy reads the Host header from the first request line.
 *
 * Unknown / missing token → deny (safe default).
 */

import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import type { AuditWriter } from '@skelm/core'
import { evaluate, EgressPolicyRegistry } from './egress-policy.js'
import { writeEgressAudit } from './egress-audit.js'

export interface EgressProxyOptions {
  /** Host to listen on. Defaults to 127.0.0.1. */
  host?: string
  /** Port to listen on. Defaults to 14739. */
  port?: number
  /** Audit writer for egress events. Defaults to no-op. */
  auditWriter?: AuditWriter
}

export class EgressProxy {
  private server: Server | null = null
  readonly registry = new EgressPolicyRegistry()
  private readonly host: string
  private readonly port: number
  private readonly audit: AuditWriter

  constructor(opts: EgressProxyOptions = {}) {
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 14739
    this.audit = opts.auditWriter ?? { write: async () => {} }
  }

  get proxyUrl(): string {
    return `http://${this.host}:${this.port}`
  }

  /** Generate a unique token and return it. Caller registers it with a policy. */
  static generateToken(): string {
    return randomBytes(24).toString('hex')
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        socket.once('data', (chunk) => this.handleFirstChunk(socket, chunk))
        socket.on('error', () => socket.destroy())
      })
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => resolve())
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server === null) return resolve()
      this.server.close(() => resolve())
      this.server = null
    })
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private handleFirstChunk(socket: Socket, chunk: Buffer): void {
    const text = chunk.toString('utf8')
    const firstLine = text.split('\r\n')[0] ?? ''

    if (firstLine.startsWith('CONNECT ')) {
      this.handleConnect(socket, text, firstLine)
    } else {
      this.handleHttp(socket, text, firstLine)
    }
  }

  private handleConnect(socket: Socket, raw: string, firstLine: string): void {
    // CONNECT api.openai.com:443 HTTP/1.1
    const hostPort = firstLine.split(' ')[1] ?? ''
    const host = hostPort.split(':')[0] ?? ''
    const port = parseInt(hostPort.split(':')[1] ?? '443', 10)

    const token = extractToken(raw)
    const policy = token ? this.registry.resolve(token) : undefined
    const decision = policy
      ? evaluate(policy, host)
      : { allow: false as const, reason: 'no-policy' as const }

    void writeEgressAudit(this.audit, host, policy, decision)

    if (!decision.allow) {
      socket.write('HTTP/1.1 407 Proxy Authorization Required\r\n\r\n')
      socket.destroy()
      return
    }

    // Tunnel
    const target = createConnection(host, port, socket)
    target.on('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      target.pipe(socket)
      socket.pipe(target)
    })
    target.on('error', () => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
    })
    socket.on('error', () => target.destroy())
  }

  private handleHttp(socket: Socket, raw: string, firstLine: string): void {
    // GET http://example.com/path HTTP/1.1
    const host = extractHttpHost(raw, firstLine)

    const token = extractToken(raw)
    const policy = token ? this.registry.resolve(token) : undefined
    const decision = policy
      ? evaluate(policy, host)
      : { allow: false as const, reason: 'no-policy' as const }

    void writeEgressAudit(this.audit, host, policy, decision)

    if (!decision.allow) {
      socket.write('HTTP/1.1 407 Proxy Authorization Required\r\n\r\n')
      socket.destroy()
      return
    }

    // Re-assemble and forward plain HTTP
    const urlMatch = firstLine.match(/^[A-Z]+ (https?:\/\/[^/\s]+)(\/[^\s]*)/)
    const targetHost = host
    const targetPort = 80
    const path = urlMatch?.[2] ?? '/'
    const rewritten = raw.replace(firstLine, firstLine.replace(/https?:\/\/[^/\s]+/, ''))

    const target = createConnection(targetHost, targetPort, socket)
    target.on('connect', () => {
      target.write(rewritten)
      target.pipe(socket)
      socket.pipe(target)
    })
    target.on('error', () => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
    })
    socket.on('error', () => target.destroy())
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

import { connect } from 'node:net'

function createConnection(host: string, port: number, client: Socket): Socket {
  const target = connect({ host, port })
  client.on('close', () => target.destroy())
  return target
}

function extractToken(raw: string): string | undefined {
  const match = raw.match(/Proxy-Authorization:\s*Bearer\s+([^\r\n]+)/i)
  return match?.[1]?.trim()
}

function extractHttpHost(raw: string, firstLine: string): string {
  // Try Host header first
  const hostHeader = raw.match(/^Host:\s*([^\r\n]+)/im)
  if (hostHeader?.[1]) return hostHeader[1].trim().split(':')[0] ?? ''
  // Fall back to URL in first line
  const urlMatch = firstLine.match(/https?:\/\/([^/:]+)/)
  return urlMatch?.[1] ?? ''
}
