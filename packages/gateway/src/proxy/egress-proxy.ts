/**
 * Embedded CONNECT proxy for network egress enforcement.
 *
 * This proxy:
 * - Listens on a configurable port (default: server.port + 1)
 * - Handles CONNECT requests for HTTPS tunneling
 * - Handles HTTP requests (for non-TLS traffic)
 * - Enforces networkEgress policies per-agent-step via token-based auth
 * - Emits audit events for every allow/deny decision
 */

import { createServer, type Server, type Socket, createConnection } from 'node:net'
import type { AuditWriter } from '@skelm/core'
import type { NetworkPolicy } from '@skelm/core'
import {
  type PolicyCheckResult,
  checkHostPolicy,
  extractHostnameFromConnectTarget,
  extractHostnameFromHostHeader,
  type TokenPolicyMap,
} from './egress-policy.js'
import { emitEgressAudit, type NetworkEgressEvent } from './egress-audit.js'

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
   * Stop the proxy server.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    return new Promise((resolve) => {
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
    // Read the first line to determine request type
    let buffer = ''

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()

      // Check if we have a complete request line
      const lines = buffer.split('\r\n')
      if (lines.length < 2) {
        return // Need more data
      }

      const firstLine = lines[0]
      if (!firstLine) {
        return // Need more data
      }
      const parts = firstLine.split(' ')

      if (parts[0] === 'CONNECT' && parts[1]) {
        // CONNECT request for HTTPS tunneling
        this.handleConnect(socket, buffer, parts[1])
      } else if (parts[0] === 'GET' || parts[0] === 'POST') {
        // HTTP request (non-TLS)
        this.handleHttp(socket, buffer)
      } else {
        // Unknown request type
        this.rejectConnection(socket, '501 Not Implemented', 'Unknown request type')
        socket.end()
      }

      socket.removeListener('data', onData)
    }

    socket.on('data', onData)

    // Handle socket errors
    socket.on('error', (err) => {
      // Connection error, nothing we can do
    })

    // Handle socket close
    socket.on('close', () => {
      socket.removeListener('data', onData)
    })
  }

  /**
   * Handle CONNECT request.
   */
  private handleConnect(socket: Socket, request: string, target: string): void {
    const hostname = extractHostnameFromConnectTarget(target)
    const authHeader = this.extractAuthHeader(request)
    const token = this.extractTokenFromAuth(authHeader)

    // Get policy for this token
    const policy = token ? this.tokenStore.get(token) : undefined
    const effectivePolicy = policy ?? this.defaultPolicy

    // Check policy
    const result = checkHostPolicy(effectivePolicy, hostname)

    // Emit audit event
    const event: NetworkEgressEvent = {
      event: 'network.egress',
      runId: this.extractRunIdFromToken(token),
      stepId: this.extractStepIdFromToken(token),
      host: hostname,
      decision: result.allowed ? 'allow' : 'deny',
      reason: result.reason ?? 'unknown-token',
      timestamp: new Date().toISOString(),
    }

    void emitEgressAudit(this.auditWriter, event).catch(() => {
      // Audit failure doesn't block the connection
    })

    if (!result.allowed) {
      this.rejectConnection(socket, '403 Forbidden', `Egress denied: ${result.reason ?? 'unknown'}`)
      socket.end()
      return
    }

    // Allowed - establish tunnel
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // Now we need to forward data between the client and the destination
    // We'll use net.connect to create the destination connection
    const parts = target.split(':')
    const destHost = parts[0]
    const destPortStr = parts[1]
    if (!destHost) {
      socket.end()
      return
    }
    const destPort = parseInt(destPortStr || '443', 10) || 443

    const destSocket = connectToHost(destHost, destPort, () => {
      // Start bidirectional forwarding
      socket.pipe(destSocket)
      destSocket.pipe(socket)
    })

    destSocket.on('error', () => {
      socket.end()
    })

    socket.on('error', () => {
      destSocket.end()
    })

    socket.on('close', () => {
      destSocket.end()
    })
  }

  /**
   * Handle HTTP request (non-TLS).
   */
  private handleHttp(socket: Socket, request: string): void {
    // Extract Host header
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
    const authHeader = this.extractAuthHeader(request)
    const token = this.extractTokenFromAuth(authHeader)

    // Get policy for this token
    const policy = token ? this.tokenStore.get(token) : undefined
    const effectivePolicy = policy ?? this.defaultPolicy

    // Check policy
    const result = checkHostPolicy(effectivePolicy, hostname)

    // Emit audit event
    const event: NetworkEgressEvent = {
      event: 'network.egress',
      runId: this.extractRunIdFromToken(token),
      stepId: this.extractStepIdFromToken(token),
      host: hostname,
      decision: result.allowed ? 'allow' : 'deny',
      reason: result.reason ?? 'unknown-token',
      timestamp: new Date().toISOString(),
    }

    void emitEgressAudit(this.auditWriter, event).catch(() => {
      // Audit failure doesn't block the connection
    })

    if (!result.allowed) {
      this.rejectConnection(socket, '403 Forbidden', `Egress denied: ${result.reason ?? 'unknown'}`)
      socket.end()
      return
    }

    // For HTTP, we need to forward the request to the destination
    const hostParts = hostname.split(':')
    const destHost = hostParts[0]
    const destPortStr = hostParts[1]
    if (!destHost) {
      this.rejectConnection(socket, '400 Bad Request', 'Invalid host')
      socket.end()
      return
    }
    const destPort = parseInt(destPortStr || '80', 10) || 80

    // Reconstruct the request to send to the destination
    const lines = request.split('\r\n')
    const firstLine = lines[0]
    if (!firstLine) {
      this.rejectConnection(socket, '400 Bad Request', 'Invalid request')
      socket.end()
      return
    }
    const destRequest = lines.map((line, i) => {
      if (i === 0) {
        return firstLine
      }
      // Replace Host header with actual destination
      if (line.toLowerCase().startsWith('host:')) {
        return `Host: ${destHost}`
      }
      return line
    }).join('\r\n')

    const destSocket = connectToHost(destHost, destPort, () => {
      destSocket.write(destRequest)
      socket.pipe(destSocket)
      destSocket.pipe(socket)
    })

    destSocket.on('error', () => {
      socket.end()
    })

    socket.on('error', () => {
      destSocket.end()
    })
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
   * Extract Authorization or Proxy-Authorization header from request.
   */
  private extractAuthHeader(request: string): string | undefined {
    // Check Proxy-Authorization first (standard for CONNECT requests)
    let match = request.match(/Proxy-Authorization:\s*([^\r\n]+)/i)
    if (match?.[1]) return match[1].trim()
    // Fall back to Authorization for compatibility
    match = request.match(/Authorization:\s*([^\r\n]+)/i)
    return match?.[1]?.trim()
  }

  /**
   * Extract token from Bearer authorization.
   */
  private extractTokenFromAuth(authHeader: string | undefined): string | undefined {
    if (!authHeader) return undefined
    const match = authHeader.match(/^Bearer\s+(.+)$/i)
    return match?.[1]?.trim()
  }

  /**
   * Extract runId from token (token format: runId:stepId).
   */
  private extractRunIdFromToken(token: string | undefined): string {
    if (!token) return 'unknown'
    const parts = token.split(':')
    return parts[0] || 'unknown'
  }

  /**
   * Extract stepId from token (token format: runId:stepId).
   */
  private extractStepIdFromToken(token: string | undefined): string {
    if (!token) return 'unknown'
    const parts = token.split(':')
    return parts[1] || 'unknown'
  }
}

/**
 * Create a TCP connection to a host:port.
 */
function connectToHost(host: string, port: number, onConnect: () => void): Socket {
  const socket = createConnection(port, host)
  socket.once('connect', onConnect)
  return socket
}
