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

import { lookup as dnsLookup } from 'node:dns/promises'
import { type Server, type Socket, createConnection, createServer, isIP } from 'node:net'
import type { AuditWriter } from '@skelm/core'
import { type NetworkPolicy, isMetadataAddress } from '@skelm/core'
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
  /**
   * Permit egress to cloud instance-metadata addresses (169.254.0.0/16,
   * fd00:ec2::254). Default: false — reaching metadata is the canonical
   * SSRF→credential-theft path, never a legitimate egress target. Set true
   * only for an operator that genuinely needs to proxy to a metadata endpoint.
   */
  allowMetadataEgress?: boolean
  /**
   * Hostname resolver used to pin the dial to a validated IP (and reject names
   * that resolve to a metadata address). Test seam; defaults to dns.lookup.
   */
  lookup?: (hostname: string) => Promise<ReadonlyArray<{ address: string }>>
}

/** HTTP request methods we forward to handleHttp() (anything not CONNECT). */
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE'])

/** Cap the request head buffered before a complete request line is seen, so a
 *  client streaming a headless blob can't grow proxy memory unbounded. */
const MAX_REQUEST_HEAD_BYTES = 64 * 1024
/** A client must send a complete request line within this window or the
 *  pre-tunnel socket is closed (slow-loris guard). Cleared once a request is
 *  handed off, so it never applies to an established tunnel. */
const HEADER_PHASE_TIMEOUT_MS = 10_000
/** Bound destination DNS resolution so a slow/dead resolver can't hold the
 *  connection (and a tunnel setup) open while a lookup hangs — fall back to
 *  dialing by name on timeout. Generous for real DNS (cloud resolvers answer in
 *  well under a second) while keeping a hung lookup from pinning the tunnel. */
const DNS_LOOKUP_TIMEOUT_MS = 3_000

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
  private readonly allowMetadataEgress: boolean
  private readonly lookup: (hostname: string) => Promise<ReadonlyArray<{ address: string }>>
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
    this.allowMetadataEgress = options.allowMetadataEgress ?? false
    this.lookup = options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true }))
  }

  /**
   * Resolve a destination and decide whether the dial may proceed. Blocks any
   * target — a literal IP or a hostname that resolves to one — in a cloud
   * metadata range (unless `allowMetadataEgress`). Returns the validated IP so
   * the caller can pin the dial to it (defeating DNS rebinding between this
   * check and the connect). On resolution failure, fail closed: dialing an
   * unchecked hostname would skip the metadata classification.
   */
  private async validateDestination(rawHost: string): Promise<{ ip?: string; blocked: boolean }> {
    // CONNECT/Host targets carry IPv6 literals in brackets (`[::1]`); strip them
    // so net.isIP recognises the literal and we dial the bare address.
    const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
    if (isIP(host) !== 0) {
      if (!this.allowMetadataEgress && isMetadataAddress(host)) return { blocked: true }
      return { ip: host, blocked: false }
    }
    try {
      const addrs = await this.lookupWithTimeout(host)
      if (!this.allowMetadataEgress && addrs.some((a) => isMetadataAddress(a.address))) {
        return { blocked: true }
      }
      const ip = addrs[0]?.address
      return ip !== undefined ? { ip, blocked: false } : { blocked: false }
    } catch {
      if (!this.allowMetadataEgress) return { blocked: true }
      return { blocked: false }
    }
  }

  private async lookupWithTimeout(host: string): Promise<ReadonlyArray<{ address: string }>> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.lookup(host),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`dns lookup for "${host}" timed out`)),
            DNS_LOOKUP_TIMEOUT_MS,
          )
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
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

    // Slow-loris guard: close the socket if a full request line never arrives.
    // Cleared on hand-off (below), so it never fires on an established tunnel.
    const headerTimer = setTimeout(() => {
      this.rejectConnection(socket, '408 Request Timeout', 'Timed out reading request head')
      socket.end()
    }, HEADER_PHASE_TIMEOUT_MS)
    headerTimer.unref?.()

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()

      // Reject a client that streams a large blob without ever completing a
      // request line — bounds the pre-parse buffer.
      if (buffer.length > MAX_REQUEST_HEAD_BYTES) {
        clearTimeout(headerTimer)
        socket.removeListener('data', onData)
        this.rejectConnection(
          socket,
          '431 Request Header Fields Too Large',
          'Request head too large',
        )
        socket.end()
        return
      }

      // Wait for at least one complete request line.
      const lines = buffer.split('\r\n')
      if (lines.length < 2) {
        return // Need more data
      }

      const firstLine = lines[0]
      if (!firstLine) {
        return // Need more data
      }
      clearTimeout(headerTimer)
      const method = firstLine.split(' ')[0]
      const target = firstLine.split(' ')[1]

      // Stop flowing BEFORE the async upstream dial and BEFORE removing this
      // listener. Removing the only 'data' handler while a socket is in flowing
      // mode discards subsequently-arriving bytes (Node stream semantics), so a
      // client's TLS ClientHello — sent the instant it sees our `200 Connection
      // Established`, while the destination dial is still in flight — was lost
      // and the tunnel hung. Pausing buffers those bytes; handleConnect/Http
      // resume the socket via .pipe() once the destination connects.
      socket.pause()
      socket.removeListener('data', onData)

      if (method === 'CONNECT' && target) {
        // Destination validation resolves DNS, so the handler is async; never
        // let a rejection escape to the gateway loop as an unhandled rejection.
        void this.handleConnect(socket, buffer, target).catch((err) =>
          this.onHandlerError(socket, err),
        )
      } else if (method !== undefined && HTTP_METHODS.has(method)) {
        // Any standard HTTP verb gets forwarded as a plain-HTTP request.
        void this.handleHttp(socket, buffer).catch((err) => this.onHandlerError(socket, err))
      } else {
        // Unknown / unsupported request type
        this.rejectConnection(socket, '501 Not Implemented', 'Unknown request type')
        socket.end()
      }
    }

    socket.on('data', onData)

    // Handle socket errors silently — connection-level errors aren't
    // actionable from the proxy's perspective.
    socket.on('error', () => clearTimeout(headerTimer))

    socket.on('close', () => {
      clearTimeout(headerTimer)
      socket.removeListener('data', onData)
    })
  }

  /**
   * Handle CONNECT request.
   */
  private async handleConnect(socket: Socket, request: string, target: string): Promise<void> {
    const hostname = extractHostnameFromConnectTarget(target)
    const token = this.extractToken(request)
    const tokenPresent = hasAuthHeader(request)

    const policy = token !== undefined ? this.tokenStore.get(token) : undefined
    const effectivePolicy = policy ?? this.defaultPolicy

    const result = checkHostPolicy(effectivePolicy, hostname)

    // Resolve + classify the destination only once the policy already allows;
    // a policy deny short-circuits. A metadata target (literal or resolved)
    // turns the decision into a deny with reason 'blocked-address'.
    const dest = result.allowed ? await this.validateDestination(hostname) : { blocked: false }
    const allowed = result.allowed && !dest.blocked

    this.emitDecision({
      token,
      tokenPresent,
      host: hostname,
      allowed,
      policyReason: dest.blocked ? 'blocked-address' : result.reason,
      // No matched policy ⇒ treat as unknown-token regardless of whether the
      // request had an auth header. Covers (a) no header at all, (b) malformed
      // header that didn't yield a token, and (c) a well-formed token that is
      // not (any longer) in the store. A metadata block takes precedence — it
      // is an identified-but-forbidden destination, not an unidentified caller.
      isUnknownToken: policy === undefined && !dest.blocked,
      socket,
    })

    if (!allowed) {
      const reason = dest.blocked ? 'blocked-address' : (result.reason ?? 'unknown')
      this.rejectConnection(socket, '403 Forbidden', `Egress denied: ${reason}`)
      socket.end()
      return
    }

    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // Forward bytes between the client and the destination. Pin to the resolved
    // IP when available so a name can't rebind to metadata after validation.
    const parts = target.split(':')
    const destPortStr = parts[1]
    const dialHost = dest.ip ?? parts[0]
    if (!dialHost) {
      socket.end()
      return
    }
    const destPort = Number.parseInt(destPortStr || '443', 10) || 443

    const destSocket = connectToHost(dialHost, destPort, () => {
      // Resume the (paused) client socket so buffered + future bytes flow.
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
  private async handleHttp(socket: Socket, request: string): Promise<void> {
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

    const dest = result.allowed ? await this.validateDestination(hostname) : { blocked: false }
    const allowed = result.allowed && !dest.blocked

    this.emitDecision({
      token,
      tokenPresent,
      host: hostname,
      allowed,
      policyReason: dest.blocked ? 'blocked-address' : result.reason,
      // See note in handleConnect: any unmatched policy ⇒ unknown-token,
      // independent of header presence; a metadata block takes precedence.
      isUnknownToken: policy === undefined && !dest.blocked,
      socket,
    })

    if (!allowed) {
      const reason = dest.blocked ? 'blocked-address' : (result.reason ?? 'unknown')
      this.rejectConnection(socket, '403 Forbidden', `Egress denied: ${reason}`)
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
    // Pin to the resolved IP when available (DNS-rebinding defense).
    const dialHost = dest.ip ?? destHost

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

    const destSocket = connectToHost(dialHost, destPort, () => {
      destSocket.write(destRequest)
      socket.pipe(destSocket)
      destSocket.pipe(socket)
    })

    destSocket.on('error', () => socket.end())
    socket.on('error', () => destSocket.end())
  }

  /**
   * Last-resort handler for an UNEXPECTED throw in the async connect/HTTP
   * chain. The normal deny/block paths return cleanly (and are audited), so
   * reaching here means a bug or an unforeseen runtime error — surface it to
   * stderr instead of silently swallowing it, then close the socket so the
   * rejection never escapes to the gateway loop.
   */
  private onHandlerError(socket: Socket, err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`[skelm egress-proxy] unexpected error handling connection: ${detail}\n`)
    socket.end()
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
    const runId = extractRunIdFromToken(args.token)
    const stepId = extractStepIdFromToken(args.token)
    const event: NetworkEgressEvent = {
      event: 'network.egress',
      ...(runId !== undefined && { runId }),
      ...(stepId !== undefined && { stepId }),
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

const POLICY_REASONS = [
  'egress-denied',
  'not-in-allowlist',
  'unknown-token',
  'blocked-address',
] as const
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
 * Returns `undefined` when the token is absent or malformed — the audit
 * event then omits the field, so downstream consumers can use plain
 * presence checks instead of special-casing the historical sentinel
 * string `"unknown"`.
 */
function extractRunIdFromToken(token: string | undefined): string | undefined {
  if (!token) return undefined
  const idx = token.indexOf(':')
  if (idx < 0) return token || undefined
  return token.slice(0, idx) || undefined
}

function extractStepIdFromToken(token: string | undefined): string | undefined {
  if (!token) return undefined
  const idx = token.indexOf(':')
  if (idx < 0) return undefined
  return token.slice(idx + 1) || undefined
}

/**
 * Create a TCP connection to a host:port.
 */
function connectToHost(host: string, port: number, onConnect: () => void): Socket {
  const socket = createConnection(port, host)
  socket.once('connect', onConnect)
  return socket
}
