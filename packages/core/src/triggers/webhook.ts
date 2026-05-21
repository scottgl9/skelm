/**
 * Webhook trigger implementation
 *
 * Receives HTTP webhook events and emits them as trigger events
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { parse } from 'node:url'
import { TriggerPluginBase } from './base.js'
import type { TriggerConfig, TriggerEvent, TriggerHealthStatus, TriggerType } from './types.js'

/** Default replay window in seconds for `x-webhook-timestamp`. */
const DEFAULT_REPLAY_WINDOW_S = 300

/**
 * Webhook trigger configuration
 */
export interface WebhookTriggerConfig extends TriggerConfig {
  /** Port to listen on */
  port: number
  /** Path to listen on (e.g., "/webhook") */
  path?: string
  /**
   * Optional HMAC secret. When set, requests must carry an HMAC-SHA256
   * signature in `x-webhook-signature` (format: `sha256=<hex>`) computed
   * over `<timestamp>.<raw-body>` and a `x-webhook-timestamp` header
   * within the replay window. Missing or invalid signature → 401.
   */
  secret?: string
  /** Replay window for the timestamp header in seconds. Defaults to 300 (5 min). */
  replayWindowSeconds?: number
  /** Maximum request body size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number
  /** Optional workflow ID to invoke */
  workflowId?: string
  /** Optional input data to pass to the workflow */
  input?: unknown
}

/**
 * Webhook trigger plugin
 */
export class WebhookTrigger extends TriggerPluginBase {
  private server: Server | null = null

  constructor(id: string, name: string, description?: string) {
    super(id, name, '1.0.0', description)
  }

  override getTriggerType(): TriggerType {
    return 'webhook'
  }

  override async doInitialize(config: WebhookTriggerConfig): Promise<void> {
    this.config = config
    this.logger.info(`Initialized webhook trigger on port ${config.port}`)
  }

  override async doStart(): Promise<void> {
    const config = this.config
    if (!config) {
      throw new Error('Webhook trigger not initialized')
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res).catch((error) => {
          this.logger.error(
            `Request handler error: ${error instanceof Error ? error.message : String(error)}`,
          )
          res.writeHead(500)
          res.end('Internal Server Error')
        })
      })

      this.server.once('error', (error: Error) => {
        this.logger.error(`Server error: ${error.message}`)
        reject(error)
      })

      this.server.listen(config.port, () => {
        this.logger.info(`Webhook trigger listening on port ${config.port}${config.path || ''}`)
        resolve()
      })
    })
  }

  override async doStop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server?.close((error?: Error) => {
          if (error) {
            this.logger.error(`Failed to stop server: ${error.message}`)
            reject(error)
          } else {
            this.logger.info('Webhook trigger stopped')
            this.server = null
            resolve()
          }
        })
      })
    }
  }

  override async doHealthCheck(): Promise<TriggerHealthStatus> {
    const config = this.config
    return {
      healthy: this.server !== null,
      status: this.server ? 'listening' : 'not-running',
      details: {
        port: config?.port,
        path: config?.path,
      },
    }
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = parse(req.url || '/')
    const config = this.config as WebhookTriggerConfig | undefined

    if (!config || pathname !== config.path) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    const maxBytes = config.maxBodyBytes ?? 1_048_576
    let raw: string
    try {
      raw = await this.readRawBody(req, maxBytes)
    } catch (err) {
      this.logger.warn(`webhook body read failed: ${(err as Error).message}`)
      res.writeHead(413)
      res.end('Payload Too Large')
      return
    }

    if (config.secret !== undefined) {
      const verdict = verifySignature(req, raw, config.secret, config.replayWindowSeconds)
      if (verdict !== 'ok') {
        this.logger.warn(`webhook auth rejected: ${verdict}`)
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
    }

    const body = parseJsonBody(raw)
    this.logger.debug(`Received webhook payload (${raw.length} bytes)`)

    // Create event
    const event: TriggerEvent = {
      eventId: `webhook-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      triggerId: this.id,
      triggerType: 'webhook',
      timestamp: new Date(),
      payload: body,
      metadata: {
        source: 'webhook',
        url: req.url || '',
        method: req.method || 'GET',
        headers: this.sanitizeHeaders(req.headers),
        ...(config.workflowId !== undefined && { workflowId: config.workflowId }),
      },
    }

    // Emit event
    await this.emitEvent(event)

    // Send response
    res.writeHead(200)
    res.end('OK')
  }

  /**
   * Read the request body as a UTF-8 string, capped at maxBytes. Rejects
   * with a typed error when the body exceeds the cap so the caller can
   * return 413 instead of buffering an unbounded payload. The remaining
   * body is drained (not destroyed) so the caller's response can still
   * be written cleanly before the socket closes.
   */
  private readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let received = 0
      let exceeded = false
      req.on('data', (chunk: Buffer) => {
        if (exceeded) return
        received += chunk.length
        if (received > maxBytes) {
          exceeded = true
          reject(new Error(`body exceeds maxBodyBytes (${maxBytes})`))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (!exceeded) resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', (err) => {
        if (!exceeded) reject(err)
      })
    })
  }

  /**
   * Sanitize headers for logging
   */
  private sanitizeHeaders(headers: IncomingMessage['headers']): Record<string, string> {
    const sanitized: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase().includes('authorization') || key.toLowerCase().includes('secret')) {
        sanitized[key] = '[REDACTED]'
      } else if (typeof value === 'string') {
        sanitized[key] = value
      } else if (Array.isArray(value)) {
        sanitized[key] = value.join(', ')
      }
    }

    return sanitized
  }
}

/**
 * Verify a webhook signature against the raw body using HMAC-SHA256.
 *
 * Expected headers:
 *   x-webhook-signature: sha256=<hex>
 *   x-webhook-timestamp: <unix-seconds>
 *
 * Signed payload: `<timestamp>.<raw-body>` — binding the timestamp into
 * the MAC prevents an attacker from replaying a captured signed body
 * outside the replay window.
 *
 * Exported for tests; the trigger itself calls it inline.
 */
export function verifySignature(
  req: IncomingMessage,
  rawBody: string,
  secret: string,
  replayWindowSeconds: number = DEFAULT_REPLAY_WINDOW_S,
): 'ok' | 'missing-signature' | 'missing-timestamp' | 'stale-timestamp' | 'bad-signature' {
  const sigHeader = req.headers['x-webhook-signature']
  if (typeof sigHeader !== 'string' || sigHeader.length === 0) return 'missing-signature'
  const tsHeader = req.headers['x-webhook-timestamp']
  if (typeof tsHeader !== 'string' || tsHeader.length === 0) return 'missing-timestamp'
  const ts = Number.parseInt(tsHeader, 10)
  if (!Number.isFinite(ts)) return 'missing-timestamp'
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts)
  if (skew > replayWindowSeconds) return 'stale-timestamp'
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
  const provided = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(provided, 'hex')
  if (a.length !== b.length) return 'bad-signature'
  return timingSafeEqual(a, b) ? 'ok' : 'bad-signature'
}

function parseJsonBody(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

/**
 * Create a webhook trigger
 */
export function createWebhookTrigger(
  id: string,
  name: string,
  description?: string,
): WebhookTrigger {
  return new WebhookTrigger(id, name, description)
}
