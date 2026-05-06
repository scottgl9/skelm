import type { Integration, IntegrationConfig } from './types.js'

/**
 * Registry for managing multiple integrations
 * Handles lifecycle, discovery, and routing
 */
export class IntegrationRegistry {
  private integrations = new Map<string, Integration>()
  private eventHandlers = new Map<string, Array<(event: unknown) => Promise<unknown>>>()

  /**
   * Register an integration
   */
  async register(integration: Integration): Promise<void> {
    if (this.integrations.has(integration.id)) {
      throw new Error(`Integration ${integration.id} already registered`)
    }

    this.integrations.set(integration.id, integration)
    await integration.init()
  }

  /**
   * Unregister an integration
   */
  async unregister(integrationId: string): Promise<void> {
    const integration = this.integrations.get(integrationId)
    if (!integration) {
      throw new Error(`Integration ${integrationId} not found`)
    }

    await integration.shutdown()
    this.integrations.delete(integrationId)
  }

  /**
   * Get an integration by ID
   */
  get(integrationId: string): Integration | undefined {
    return this.integrations.get(integrationId)
  }

  /**
   * List all registered integrations
   */
  list(): Integration[] {
    return Array.from(this.integrations.values())
  }

  /**
   * Get enabled integrations
   */
  listEnabled(): Integration[] {
    return this.list().filter((i) => i.config.enabled)
  }

  /**
   * Check if an integration is registered
   */
  has(integrationId: string): boolean {
    return this.integrations.has(integrationId)
  }

  /**
   * Register an event handler for a specific integration
   */
  onEvent(integrationId: string, handler: (event: unknown) => Promise<unknown>): void {
    if (!this.eventHandlers.has(integrationId)) {
      this.eventHandlers.set(integrationId, [])
    }
    this.eventHandlers.get(integrationId)?.push(handler)
  }

  /**
   * Remove an event handler
   */
  offEvent(integrationId: string, handler: (event: unknown) => Promise<unknown>): void {
    const handlers = this.eventHandlers.get(integrationId)
    if (!handlers) {
      return
    }

    const index = handlers.indexOf(handler)
    if (index >= 0) {
      handlers.splice(index, 1)
    }
  }

  /**
   * Dispatch an event to all handlers for an integration.
   * Errors from handlers are not swallowed — they propagate to the caller
   * so auth failures and misconfiguration are surfaced rather than hidden.
   */
  async dispatchEvent(integrationId: string, event: unknown): Promise<unknown[]> {
    const handlers = this.eventHandlers.get(integrationId) ?? []
    const results: unknown[] = []
    for (const handler of handlers) {
      results.push(await handler(event))
    }
    return results
  }

  /**
   * Get webhook path for an integration
   */
  getWebhookPath(integrationId: string): string | null {
    const integration = this.integrations.get(integrationId)
    if (!integration) {
      return null
    }

    return integration.config.webhook?.path ?? null
  }

  /**
   * Handle incoming webhook event
   */
  async handleWebhook(integrationId: string, event: unknown): Promise<unknown> {
    const integration = this.integrations.get(integrationId)
    if (!integration) {
      throw new Error(`Integration ${integrationId} not found`)
    }

    if (!integration.config.enabled) {
      throw new Error(`Integration ${integrationId} is not enabled`)
    }

    // Try to convert event to RunInput if the integration supports it.
    // Use the typed optional method from the Integration interface rather than
    // a duck-type check, so only the declared interface contract is exercised.
    if (integration.eventToRunInput !== undefined) {
      const runInput = await integration.eventToRunInput(event)
      if (runInput) {
        return { type: 'run_input', data: runInput }
      }
    }

    // Otherwise, dispatch to event handlers
    const results = await this.dispatchEvent(integrationId, event)
    return { type: 'events', results }
  }

  /**
   * Shutdown all integrations
   */
  async shutdown(): Promise<void> {
    const promises = Array.from(this.integrations.values()).map((i) => i.shutdown())
    await Promise.all(promises)
    this.integrations.clear()
    this.eventHandlers.clear()
  }

  /**
   * Health check all integrations
   */
  async healthCheck(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>()

    for (const [id, integration] of this.integrations.entries()) {
      try {
        const healthy = await integration.healthCheck()
        results.set(id, healthy)
      } catch {
        results.set(id, false)
      }
    }

    return results
  }
}
