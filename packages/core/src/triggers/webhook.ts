/**
 * Webhook trigger implementation
 *
 * Receives HTTP webhook events and emits them as trigger events
 */

import { TriggerPluginBase } from './base.js'
import type { TriggerConfig, TriggerType, TriggerEvent, TriggerHealthStatus } from './types.js'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { parse } from 'url'

/**
 * Webhook trigger configuration
 */
export interface WebhookTriggerConfig extends TriggerConfig {
  /** Port to listen on */
  port: number
  /** Path to listen on (e.g., "/webhook") */
  path?: string
  /** Optional secret for signing requests */
  secret?: string
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
    const config = this.config

    if (!config || pathname !== config.path) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    // Verify secret if configured
    if (config.secret) {
      const signature = req.headers['x-webhook-signature']
      if (signature !== config.secret) {
        this.logger.warn('Invalid webhook signature')
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
    }

    // Read request body
    const body = await this.readBody(req)

    this.logger.debug(`Received webhook: ${JSON.stringify(body)}`)

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
   * Read request body
   */
  private readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []

      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })

      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch {
          resolve({ raw: body })
        }
      })

      req.on('error', () => {
        resolve({})
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
 * Create a webhook trigger
 */
export function createWebhookTrigger(
  id: string,
  name: string,
  description?: string,
): WebhookTrigger {
  return new WebhookTrigger(id, name, description)
}
