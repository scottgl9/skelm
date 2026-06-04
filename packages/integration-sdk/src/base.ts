import { IntegrationRateLimitError } from './errors.js'
import type { Integration, IntegrationCapabilities, IntegrationConfig } from './types.js'

/**
 * Base class for all integrations.
 *
 * Provides common lifecycle management (init/shutdown), health checks, and
 * rate-limiting helpers. Extend this class (or use `defineIntegration()`) to
 * implement a custom integration.
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
    if (this.initialized) return
    if (!this.config.enabled) return

    await this.validateCredentials()

    if (this.config.webhook && this.capabilities.canReceiveWebhooks) {
      await this.setupWebhook()
    }

    this.initialized = true
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return

    if (this.config.webhook && this.capabilities.canReceiveWebhooks) {
      await this.cleanupWebhook()
    }

    this.initialized = false
  }

  async healthCheck(): Promise<boolean> {
    if (!this.initialized) return false
    try {
      return await this.performHealthCheck()
    } catch {
      return false
    }
  }

  /** Validate credentials — implemented by subclasses */
  protected abstract validateCredentials(): Promise<void>

  /** Perform health check — implemented by subclasses */
  protected abstract performHealthCheck(): Promise<boolean>

  /** Setup webhook — override if canReceiveWebhooks */
  protected async setupWebhook(): Promise<void> {}

  /** Cleanup webhook — override if canReceiveWebhooks */
  protected async cleanupWebhook(): Promise<void> {}

  /** Check rate limit; returns false if the limit is exceeded */
  protected async checkRateLimit(): Promise<boolean> {
    const limit = this.config.rateLimit
    if (!limit) return true

    const now = Date.now()
    const windowStart = now - limit.windowMs
    this.rateLimitQueue = this.rateLimitQueue.filter((e) => e.timestamp > windowStart)

    if (this.rateLimitQueue.length >= limit.requests) return false

    this.rateLimitQueue.push({ timestamp: now })
    return true
  }

  /** Milliseconds until the next available request slot */
  protected getRateLimitWaitTime(): number {
    const limit = this.config.rateLimit
    if (!limit || this.rateLimitQueue.length === 0) return 0

    const oldest = this.rateLimitQueue[0]
    if (oldest === undefined) return 0
    const windowStart = Date.now() - limit.windowMs
    if (oldest.timestamp <= windowStart) return 0
    return oldest.timestamp + limit.windowMs - Date.now()
  }

  protected async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Run `fn` respecting rate limits, retrying up to 3 times */
  protected async withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = 3
    let retries = 0

    while (retries < maxRetries) {
      if (await this.checkRateLimit()) return await fn()
      const waitTime = this.getRateLimitWaitTime()
      if (waitTime > 0) await this.sleep(waitTime + 100)
      retries++
    }

    throw new IntegrationRateLimitError(`Rate limit exceeded after ${maxRetries} retries`)
  }
}
