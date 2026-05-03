/**
 * GitHub trigger implementation
 * 
 * Receives GitHub webhook events
 */

import { TriggerPluginBase } from './base.js'
import type { TriggerConfig, TriggerType, TriggerEvent, TriggerHealthStatus } from './types.js'
import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { createHmac } from 'crypto'

/**
 * GitHub webhook event structure
 */
export interface GitHubWebhookEvent {
  event: string
  delivery: string
  action?: string
  [key: string]: unknown
}

/**
 * Common GitHub webhook payloads
 */
export interface GitHubPushEvent {
  ref: string
  before: string
  after: string
  repository: {
    full_name: string
    html_url: string
    default_branch: string
  }
  head_commit?: {
    id: string
    message: string
    author: {
      name: string
      email: string
      username?: string
    }
  }
}

export interface GitHubPullRequestEvent {
  action: 'opened' | 'closed' | 'reopened' | 'synchronize'
  number: number
  pull_request: {
    id: number
    number: number
    title: string
    state: string
    user: {
      login: string
      id: number
    }
    head: {
      ref: string
      sha: string
      repo: { full_name: string }
    }
    base: {
      ref: string
      sha: string
      repo: { full_name: string }
    }
  }
}

export interface GitHubIssueCommentEvent {
  action: 'created' | 'edited' | 'deleted'
  issue: {
    number: number
    title: string
    state: string
    user: { login: string }
  }
  comment: {
    id: number
    body: string
    user: { login: string }
  }
}

/**
 * GitHub trigger configuration
 */
export interface GitHubTriggerConfig extends TriggerConfig {
  /** GitHub webhook secret */
  secret?: string
  /** Port to listen on */
  port: number
  /** Path to listen on */
  path?: string
  /** GitHub events to subscribe to */
  events?: string[]
  /** Optional workflow ID to invoke */
  workflowId?: string
  /** Optional input data to pass to the workflow */
  input?: unknown
}

/**
 * GitHub trigger plugin
 */
export class GitHubTrigger extends TriggerPluginBase {
  private server: Server | null = null
  
  constructor(id: string, name: string, description?: string) {
    super(id, name, '1.0.0', description)
  }
  
  override getTriggerType(): TriggerType {
    return 'github'
  }
  
  override async doInitialize(config: GitHubTriggerConfig): Promise<void> {
    this.config = config
    this.logger.info(`Initialized GitHub trigger on port ${config.port}`)
    
    if (config.events && config.events.length > 0) {
      this.logger.info(`Subscribed to GitHub events: ${config.events.join(', ')}`)
    }
  }
  
  override async doStart(): Promise<void> {
    const config = this.config
    if (!config) {
      throw new Error('GitHub trigger not initialized')
    }
    
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res).catch((error) => {
          this.logger.error(`Request handler error: ${error instanceof Error ? error.message : String(error)}`)
          res.writeHead(500)
          res.end('Internal Server Error')
        })
      })
      
      this.server.once('error', (error: Error) => {
        this.logger.error(`Server error: ${error.message}`)
        reject(error)
      })
      
      this.server.listen(config.port, () => {
        this.logger.info(`GitHub trigger listening on port ${config.port}${config.path || ''}`)
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
            this.logger.info('GitHub trigger stopped')
            this.server = null
            resolve()
          }
        })
      })
    }
  }
  
  override async doHealthCheck(): Promise<TriggerHealthStatus> {
    const config = this.config as GitHubTriggerConfig | null
    return {
      healthy: this.server !== null,
      status: this.server ? 'listening' : 'not-running',
      details: {
        port: config?.port,
        path: config?.path,
        eventCount: config?.events?.length || 0,
      },
    }
  }
  
  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = this.config as GitHubTriggerConfig | null
    if (!config) {
      res.writeHead(500)
      res.end('Not initialized')
      return
    }
    
    const { pathname } = new URL(req.url || '/', 'http://localhost')
    
    if (pathname !== config.path) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    
    // Verify GitHub signature
    const signature = req.headers['x-hub-signature-256'] as string | undefined
    const event = req.headers['x-github-event'] as string | undefined
    
    if (config.secret && signature) {
      const body = await this.readBody(req)
      const expectedSignature = this.computeSignature(config.secret, body)
      
      if (signature !== expectedSignature) {
        this.logger.warn('Invalid GitHub signature')
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
      
      // Check event filter
      if (config.events && event && !config.events.includes(event)) {
        this.logger.debug(`Ignoring GitHub event: ${event}`)
        res.writeHead(200)
        res.end('Ignored')
        return
      }
      
      await this.emitWebhookEvent(event || 'unknown', body)
    } else {
      // No secret configured, accept all events
      const body = await this.readBody(req)
      await this.emitWebhookEvent(event || 'unknown', body)
    }
    
    res.writeHead(200)
    res.end('OK')
  }
  
  /**
   * Read request body
   */
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      
      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      
      req.on('error', () => {
        resolve('')
      })
    })
  }
  
  /**
   * Compute GitHub signature
   */
  private computeSignature(secret: string, payload: string): string {
    const hmac = createHmac('sha256', secret)
    hmac.update(payload)
    return `sha256=${hmac.digest('hex')}`
  }
  
  /**
   * Emit a GitHub webhook event
   */
  private async emitWebhookEvent(eventType: string, payload: string): Promise<void> {
    let parsedPayload: unknown
    try {
      parsedPayload = JSON.parse(payload)
    } catch {
      parsedPayload = { raw: payload }
    }
    
    const config = this.config as GitHubTriggerConfig | null
    
    const triggerEvent: TriggerEvent = {
      eventId: `github-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      triggerId: this.id,
      triggerType: 'github',
      timestamp: new Date(),
      payload: parsedPayload,
      metadata: {
        source: 'github',
        githubEventType: eventType,
        ...(config?.workflowId !== undefined && { workflowId: config.workflowId }),
      },
    }
    
    await this.emitEvent(triggerEvent)
    
    this.logger.debug(`Processed GitHub ${eventType} event`)
  }
}

/**
 * Create a GitHub trigger
 */
export function createGitHubTrigger(id: string, name: string, description?: string): GitHubTrigger {
  return new GitHubTrigger(id, name, description)
}
