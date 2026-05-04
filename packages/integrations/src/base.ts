import type { Integration, IntegrationConfig, IntegrationCapabilities } from './types.js'

/**
 * Base class for all integrations
 * Provides common functionality for lifecycle management, health checks, and rate limiting
 */
export abstract class IntegrationBase implements Integration {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly capabilities: IntegrationCapabilities

  config: IntegrationConfig
  private initialized = false
  private rateLimitQueue: Array<{ timestamp: number }> = []

  constructor(config: IntegrationConfig) {
    this.config = config
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return
    }

    if (!this.config.enabled) {
      return
    }

    // Validate credentials
    await this.validateCredentials()

    // Setup webhooks if configured
    if (this.config.webhook && this.capabilities.canReceiveWebhooks) {
      await this.setupWebhook()
    }

    this.initialized = true
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return
    }

    // Cleanup webhooks
    if (this.config.webhook && this.capabilities.canReceiveWebhooks) {
      await this.cleanupWebhook()
    }

    this.initialized = false
  }

  async healthCheck(): Promise<boolean> {
    if (!this.initialized) {
      return false
    }

    try {
      return await this.performHealthCheck()
    } catch {
      return false
    }
  }

  /** Validate credentials - to be implemented by subclasses */
  protected abstract validateCredentials(): Promise<void>

  /** Perform health check - to be implemented by subclasses */
  protected abstract performHealthCheck(): Promise<boolean>

  /** Setup webhook - optional, only if canReceiveWebhooks */
  protected async setupWebhook(): Promise<void> {
    // Default implementation does nothing
    // Subclasses override if they support webhooks
  }

  /** Cleanup webhook - optional, only if canReceiveWebhooks */
  protected async cleanupWebhook(): Promise<void> {
    // Default implementation does nothing
  }

  /** Rate limiting check */
  protected async checkRateLimit(): Promise<boolean> {
    const limit = this.config.rateLimit
    if (!limit) {
      return true
    }

    const now = Date.now()
    const windowStart = now - limit.windowMs

    // Clean old entries
    this.rateLimitQueue = this.rateLimitQueue.filter((entry) => entry.timestamp > windowStart)

    // Check if we're over limit
    if (this.rateLimitQueue.length >= limit.requests) {
      return false
    }

    // Add current request
    this.rateLimitQueue.push({ timestamp: now })
    return true
  }

  /** Get wait time until next available request (in ms) */
  protected getRateLimitWaitTime(): number {
    const limit = this.config.rateLimit
    if (!limit || this.rateLimitQueue.length === 0) {
      return 0
    }

    const oldest = this.rateLimitQueue[0]
    const windowStart = Date.now() - limit.windowMs

    if (oldest.timestamp <= windowStart) {
      return 0
    }

    return oldest.timestamp + limit.windowMs - Date.now()
  }

  /** Sleep helper */
  protected async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** With rate limiting retry */
  protected async withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = 3
    let retries = 0

    while (retries < maxRetries) {
      if (await this.checkRateLimit()) {
        return await fn()
      }

      const waitTime = this.getRateLimitWaitTime()
      if (waitTime > 0) {
        await this.sleep(waitTime + 100) // Add small buffer
      }
      retries++
    }

    throw new Error(`Rate limit exceeded after ${maxRetries} retries`)
  }
}
