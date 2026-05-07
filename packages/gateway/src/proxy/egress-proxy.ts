/**
 * Embedded CONNECT proxy for network egress enforcement.
 *
 * This proxy:
 * - Listens on a configurable port (default: server.port + 1)
 * - Handles CONNECT requests for HTTPS tunneling
 * - Handles HTTP requests (any verb) for non-TLS traffic
 * - Enforces networkEgress policies per-agent-step via token-based auth
 * - Emits audit events for every allow/deny decision
 *
 * Authentication:
 *   The egress token is encoded as the credential field of the proxy URL
 *   (`http://token:<egressToken>@host:port`) so that any HTTP client (Node
 *   `http`/`https`, undici, curl, requests, …) sends `Proxy-Authorization:
 *   Basic <base64(token:<egressToken>)>` automatically when it sees
 *   `HTTP_PROXY` / `HTTPS_PROXY`. The proxy decodes that header and looks
 *   the token up in the per-step token store.
 *
 *   For backward compatibility we also accept `Proxy-Authorization: Bearer
 *   <token>` and `Authorization: Bearer <token>`.
 */

import { type Server, type Socket, createConnection, createServer } from 'node:net'
import type { AuditWriter } from '@skelm/core'
import type { NetworkPolicy } from '@skelm/core'
import { type NetworkEgressEvent, emitEgressAudit } from './egress-audit.js'
import {
  type TokenPolicyMap,
  checkHostPolicy,
  extractHostnameFromConnectTarget,
  extractHostnameFromHostHeader,
} from './egress-policy.js'

/**
 * Proxy configuration.
 */
export interface EgressProxyOptions {
  /** Port to listen on. Default: 14739 (server.port + 1). */
  port?: number
  /** Host to bind to. Default: 127.0.0.1 */
  host?: string
  /** Token-to-policy mapping store. */
  tokenStore: TokenPolicyMap
  /** Audit writer for logging decisions. */
  auditWriter: AuditWriter
  /** Default policy when token is unknown/missing. Default: 'deny'. */
  defaultPolicy?: NetworkPolicy
}

/** HTTP request methods we forward to handleHttp() (anything not CONNECT). */
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE'])

/**
 * Embedded CONNECT proxy server.
 */
export class EgressProxy {
  private server: Server | null = null
  private readonly port: number
  private readonly host: string
  private readonly tokenStore: TokenPolicyMap
  private readonly auditWriter: AuditWriter
  private readonly defaultPolicy: NetworkPolicy
  /**
   * Cumulative count of unknown-token deny events since this proxy started.
   * Surfaced on each `network.egress:deny` audit entry whose `reason` is
   * `unknown-token`, so operators can spot spikes (port-scans, lateral
   * movement) without having to grep counts across the audit log.
   */
  private unknownTokenDenials = 0

  constructor(private readonly options: EgressProxyOptions) {
    this.port = options.port ?? 14739
    this.host = options.host ?? '127.0.0.1'
    this.tokenStore = options.tokenStore
    this.auditWriter = options.auditWriter
    this.defaultPolicy = options.defaultPolicy ?? 'deny'
  }

  /**
   * Start the proxy server.
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error('proxy is already running')
    }

    return new Promise((resolve, reject) => {
      this.server = createServer()

      this.server.on('connection', (socket) => this.handleConnection(socket))

      this.server.on('error', (err) => {
        reject(err)
      })

      this.server.listen(this.port, this.host, () => {
        resolve()
      })
    })
  }

  /**
   * Stop the proxy server. Drains in-flight connections (TLS tunnels, HTTP
   * forwarding sockets) before resolving so a Gateway shutdown does not
   * block on long-lived sessions.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    return new Promise((resolve) => {
      // closeAllConnections (Node 18.2+) destroys keep-alive / tunnel sockets
      // so server.close() can finish promptly. Cast because the @types/node
      // version may not yet expose the method on `net.Server`.
      const srv = this.server as Server & { closeAllConnections?: () => void }
      srv?.closeAllConnections?.()
      this.server?.close(() => {
        this.server = null
        resolve()
      })
    })
  }

  /**
   * Get the bound port (useful when port 0 was requested).
   */
  getPort(): number {
    if (!this.server) {
      throw new Error('proxy is not running')
    }
    const addr = this.server.address()
    if (addr === null || typeof addr === 'string') {
      throw new Error('proxy address is unknown')
    }
    return addr.port
  }

  /**
   * Handle incoming connection.
   */
  private handleConnection(socket: Socket): void {
    let buffer = ''

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()

      // Wait for at least one complete request line.
      const lines = buffer.split('\r\n')
      if (lines.length < 2) {
        return // Need more data
      }

      const firstLine = lines[0]
      if (!firstLine) {
        return // Need more data
      }
      const method = firstLine.split(' ')[0]
      const target = firstLine.split(' ')[1]

      if (method === 'CONNECT' && target) {
        this.handleConnect(socket, buffer, target)
      } else if (method !== undefined && HTTP_METHODS.has(method)) {
        // Any standard HTTP verb gets forwarded as a plain-HTTP request.
        this.handleHttp(socket, buffer)
      } else {
        // Unknown / unsupported request type
        this.rejectConnection(socket, '501 Not Implemented', 'Unknown request type')
        socket.end()
      }

      socket.removeListener('data', onData)
    }

    socket.on('data', onData)

    // Handle socket errors silently — connection-level errors aren't
    // actionable from the proxy's perspective.
    socket.on('error', () => {})

    socket.on('close', () => {
      socket.removeListener('data', onData)
    })
  }

  /**
   * Handle CONNECT request.
   */
  private handleConnect(socket: Socket, request: string, target: string): void {
    const hostname = extractHostnameFromConnectTarget(target)
    const token = this.extractToken(request)
    const tokenPresent = hasAuthHeader(request)

    const policy = token !== undefined ? this.tokenStore.get(token) : undefined
    const effectivePolicy = policy ?? this.defaultPolicy

    const result = checkHostPolicy(effectivePolicy, hostname)

    this.emitDecision({
      token,
      tokenPresent,
      host: hostname,
      allowed: result.allowed,
      policyReason: result.reason,
      // No matched policy ⇒ treat as unknown-token regardless of whether the
      // request had an auth header. Covers (a) no header at all, (b) malformed
      // header that didn't yield a token, and (c) a well-formed token that is
      // not (any longer) in the store. All three are operationally
      // "unidentified caller".
      isUnknownToken: policy === undefined,
      socket,
    })

    if (!result.allowed) {
      this.rejectConnection(socket, '403 Forbidden', `Egress denied: ${result.reason ?? 'unknown'}`)
      socket.end()
      return
    }

    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // Forward bytes between the client and the destination.
    const parts = target.split(':')
    const destHost = parts[0]
    const destPortStr = parts[1]
    if (!destHost) {
      socket.end()
      return
    }
    const destPort = Number.parseInt(destPortStr || '443', 10) || 443

    const destSocket = connectToHost(destHost, destPort, () => {
      socket.pipe(destSocket)
      destSocket.pipe(socket)
    })

    destSocket.on('error', () => socket.end())
    socket.on('error', () => destSocket.end())
    socket.on('close', () => destSocket.end())
  }

  /**
   * Handle HTTP request (non-TLS).
   */
  private handleHttp(socket: Socket, request: string): void {
    const hostMatch = request.match(/Host:\s*([^\r\n]+)/i)
    if (!hostMatch) {
      this.rejectConnection(socket, '400 Bad Request', 'Missing Host header')
      socket.end()
      return
    }

    const hostValue = hostMatch[1]
    if (!hostValue) {
      this.rejectConnection(socket, '400 Bad Request', 'Invalid host header')
      socket.end()
      return
    }
    const hostname = extractHostnameFromHostHeader(hostValue.trim())
    const token = this.extractToken(request)
    const tokenPresent = hasAuthHeader(request)

    const policy = token !== undefined ? this.tokenStore.get(token) : undefined
    const effectivePolicy = policy ?? this.defaultPolicy

    const result = checkHostPolicy(effectivePolicy, hostname)

    this.emitDecision({
      token,
      tokenPresent,
      host: hostname,
      allowed: result.allowed,
      policyReason: result.reason,
      // See note in handleConnect: any unmatched policy ⇒ unknown-token,
      // independent of header presence.
      isUnknownToken: policy === undefined,
      socket,
    })

    if (!result.allowed) {
      this.rejectConnection(socket, '403 Forbidden', `Egress denied: ${result.reason ?? 'unknown'}`)
      socket.end()
      return
    }

    const hostParts = hostname.split(':')
    const destHost = hostParts[0]
    const destPortStr = hostParts[1]
    if (!destHost) {
      this.rejectConnection(socket, '400 Bad Request', 'Invalid host')
      socket.end()
      return
    }
    const destPort = Number.parseInt(destPortStr || '80', 10) || 80

    // Rewrite the request line: HTTP/1.1 servers expect origin-form
    // (`GET /path HTTP/1.1`), but proxy clients send absolute-form
    // (`GET http://example.com/path HTTP/1.1`). Strip the scheme+host.
    // Also drop hop-by-hop Proxy-* headers that should not leak to the
    // origin server.
    const lines = request.split('\r\n')
    const firstLine = lines[0]
    if (!firstLine) {
      this.rejectConnection(socket, '400 Bad Request', 'Invalid request')
      socket.end()
      return
    }
    const rewrittenFirstLine = rewriteRequestLineToOriginForm(firstLine)
    const destLines: string[] = [rewrittenFirstLine]
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const lower = line.toLowerCase()
      if (lower.startsWith('proxy-authorization:') || lower.startsWith('proxy-connection:')) {
        continue
      }
      if (lower.startsWith('host:')) {
        destLines.push(`Host: ${destHost}`)
        continue
      }
      destLines.push(line)
    }
    const destRequest = destLines.join('\r\n')

    const destSocket = connectToHost(destHost, destPort, () => {
      destSocket.write(destRequest)
      socket.pipe(destSocket)
      destSocket.pipe(socket)
    })

    destSocket.on('error', () => socket.end())
    socket.on('error', () => destSocket.end())
  }

  /**
   * Reject a connection with an HTTP error response.
   */
  private rejectConnection(socket: Socket, statusCode: string, statusMessage: string): void {
    socket.write(`HTTP/1.1 ${statusCode} ${statusMessage}\r\n`)
    socket.write('Content-Length: 0\r\n')
    socket.write('Connection: close\r\n')
    socket.write('\r\n')
  }

  /**
   * Emit a network.egress audit decision. `reason` is omitted when the
   * connection was allowed and no policy reason applies. For every entry,
   * the remote peer is captured (from the socket) so an operator can
   * correlate `runId: "unknown"` denies to a process. For unknown-token
   * denies specifically, a cumulative counter is also emitted so spikes
   * are visible in a single grep.
   */
  private emitDecision(args: {
    token: string | undefined
    tokenPresent: boolean
    host: string
    allowed: boolean
    policyReason: string | undefined
    isUnknownToken: boolean
    socket: Socket
  }): void {
    const event: NetworkEgressEvent = {
      event: 'network.egress',
      runId: extractRunIdFromToken(args.token),
      stepId: extractStepIdFromToken(args.token),
      host: args.host,
      decision: args.allowed ? 'allow' : 'deny',
      timestamp: new Date().toISOString(),
      tokenPresent: args.tokenPresent,
    }
    const source = readSocketPeer(args.socket)
    if (source !== undefined) event.source = source
    if (!args.allowed) {
      // Priority for `reason`:
      //   1. If the proxy never matched a token (no auth header at all,
      //      malformed header, or a well-formed token that's not in the
      //      store) → `'unknown-token'`. This is the most forensically
      //      useful reason — a known-token deny carries different
      //      operational implications (policy / allowlist mismatch) than
      //      an unidentified caller. The cumulative counter tracks this
      //      class so spikes in untokened/stale-token probes are visible
      //      in a single grep.
      //   2. Else, the policy's own denial reason ('not-in-allowlist',
      //      'egress-denied').
      //   3. Fallback `'unknown'`.
      if (args.isUnknownToken) {
        event.reason = 'unknown-token'
        this.unknownTokenDenials += 1
        event.unknownTokenDenials = this.unknownTokenDenials
      } else if (isPolicyReason(args.policyReason)) {
        event.reason = args.policyReason
      } else {
        event.reason = 'unknown'
      }
    }
    void emitEgressAudit(this.auditWriter, event).catch(() => {
      // Audit failure does not block the connection
    })
  }

  /**
   * Resolve the per-step egress token from any of:
   *   - `Proxy-Authorization: Basic <base64(user:pass)>` — primary path.
   *     The token is the password field; the username is conventionally
   *     `token` but is not enforced.
   *   - `Proxy-Authorization: Bearer <token>` — backward compat.
   *   - `Authorization: Bearer <token>` — backward compat.
   */
  private extractToken(request: string): string | undefined {
    const proxyAuth = request.match(/Proxy-Authorization:\s*([^\r\n]+)/i)?.[1]?.trim() ?? undefined
    const auth = request.match(/Authorization:\s*([^\r\n]+)/i)?.[1]?.trim() ?? undefined

    for (const header of [proxyAuth, auth]) {
      if (!header) continue
      const basic = header.match(/^Basic\s+([A-Za-z0-9+/=._-]+)$/i)
      if (basic?.[1]) {
        try {
          const decoded = Buffer.from(basic[1], 'base64').toString('utf8')
          const colonIdx = decoded.indexOf(':')
          if (colonIdx >= 0) {
            const password = decoded.slice(colonIdx + 1)
            if (password.length > 0) return password
          }
        } catch {
          // fall through to Bearer
        }
      }
      const bearer = header.match(/^Bearer\s+(.+)$/i)
      if (bearer?.[1]) return bearer[1].trim()
    }
    return undefined
  }
}

const POLICY_REASONS = ['egress-denied', 'not-in-allowlist', 'unknown-token'] as const
type PolicyReason = (typeof POLICY_REASONS)[number]
function isPolicyReason(value: string | undefined): value is PolicyReason {
  return value !== undefined && (POLICY_REASONS as readonly string[]).includes(value)
}

/**
 * Rewrite an HTTP request line from absolute-form (`GET http://host/path
 * HTTP/1.1`) to origin-form (`GET /path HTTP/1.1`). HTTP/1.1 origin servers
 * require origin-form; only proxies receive absolute-form. Leave the line
 * alone if the request-target is already in origin-form.
 */
export function rewriteRequestLineToOriginForm(firstLine: string): string {
  const space1 = firstLine.indexOf(' ')
  if (space1 < 0) return firstLine
  const space2 = firstLine.indexOf(' ', space1 + 1)
  if (space2 < 0) return firstLine
  const method = firstLine.slice(0, space1)
  const requestTarget = firstLine.slice(space1 + 1, space2)
  const httpVersion = firstLine.slice(space2 + 1)

  const schemeMatch = requestTarget.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)
  if (!schemeMatch) return firstLine

  const afterScheme = requestTarget.slice(schemeMatch[0].length)
  const slashIdx = afterScheme.indexOf('/')
  const path = slashIdx >= 0 ? afterScheme.slice(slashIdx) : '/'
  return `${method} ${path} ${httpVersion}`
}

/**
 * Read the remote peer (address + port) from a connection socket. Returns
 * undefined for the rare case where the socket has already closed by the
 * time the audit fires — never throws so audit emission can't be blocked.
 */
function readSocketPeer(socket: Socket): { address: string; port: number } | undefined {
  const address = socket.remoteAddress
  const port = socket.remotePort
  if (typeof address !== 'string' || typeof port !== 'number') return undefined
  return { address, port }
}

/**
 * Cheap presence-only check for either Authorization header. We don't care
 * about the contents here — that's `extractToken`'s job; we only want to
 * tell "the client sent an auth header at all" (probably a misconfigured
 * agent) from "no auth header" (often a port-scan).
 */
function hasAuthHeader(request: string): boolean {
  return /(?:Proxy-)?Authorization:/i.test(request)
}

/**
 * Token format: `<runId>:<stepId>`. Use the FIRST `:` as the delimiter so
 * stepIds that contain `:` (e.g. `cohort:a`) are not silently truncated.
 */
function extractRunIdFromToken(token: string | undefined): string {
  if (!token) return 'unknown'
  const idx = token.indexOf(':')
  if (idx < 0) return token || 'unknown'
  return token.slice(0, idx) || 'unknown'
}

function extractStepIdFromToken(token: string | undefined): string {
  if (!token) return 'unknown'
  const idx = token.indexOf(':')
  if (idx < 0) return 'unknown'
  return token.slice(idx + 1) || 'unknown'
}

/**
 * Create a TCP connection to a host:port.
 */
function connectToHost(host: string, port: number, onConnect: () => void): Socket {
  const socket = createConnection(port, host)
  socket.once('connect', onConnect)
  return socket
}
