import type { ZodType } from 'zod'
import { IntegrationBase } from './base.js'
import { IntegrationCredentialsError, IntegrationUnsupportedOperationError } from './errors.js'
import type {
  Integration,
  IntegrationCapabilities,
  IntegrationConfig,
  RunInput,
  WebhookConfig,
} from './types.js'

/**
 * Options passed to `defineIntegration()`.
 *
 * @typeParam TCreds - The shape of the credentials object, validated by `credentialsSchema`.
 */
export interface DefineIntegrationOptions<
  TCreds extends Record<string, string | number | boolean | undefined>,
> {
  /** Unique integration identifier (e.g. 'google', 'notion') */
  id: string

  /** Human-readable display name */
  name: string

  /** Capability flags — declare what your integration can do */
  capabilities: IntegrationCapabilities

  /**
   * Zod schema used to validate credentials at init time.
   * Use `z.object({ apiKey: z.string().min(1), ... })`.
   */
  credentialsSchema: ZodType<TCreds>

  /**
   * Called after Zod validation passes. Use this for live API calls
   * (e.g. verify the token is actually accepted by the provider).
   * Throw an Error to fail initialization.
   */
  validateCredentials?(credentials: TCreds, config: IntegrationConfig): Promise<void>

  /**
   * Return true if the integration is reachable and operational.
   * Called by `IntegrationRegistry.healthCheck()`.
   */
  performHealthCheck(credentials: TCreds, config: IntegrationConfig): Promise<boolean>

  /**
   * Called when `config.webhook` is set and `capabilities.canReceiveWebhooks`
   * is true, during `init()`. Register the webhook URL with the provider here.
   */
  setupWebhook?(
    credentials: TCreds,
    config: IntegrationConfig,
    webhook: WebhookConfig,
  ): Promise<void>

  /**
   * Called during `shutdown()` when a webhook was registered.
   * Deregister the webhook with the provider here.
   */
  cleanupWebhook?(
    credentials: TCreds,
    config: IntegrationConfig,
    webhook: WebhookConfig,
  ): Promise<void>

  /**
   * Convert a raw inbound event (webhook payload or poll result) into a
   * `RunInput` that triggers a pipeline run. Return `null` to skip the event.
   */
  eventToRunInput?(
    event: unknown,
    credentials: TCreds,
    config: IntegrationConfig,
  ): Promise<RunInput | null>

  /**
   * Send an outbound notification via the integration.
   */
  sendNotification?(
    message: string,
    options: Record<string, unknown> | undefined,
    credentials: TCreds,
    config: IntegrationConfig,
  ): Promise<void>
}

/**
 * A class constructor that produces an `IntegrationBase` for the given options.
 * Instantiate with `new MyIntegration(config)`.
 */
export type IntegrationClass<TCreds extends Record<string, string | number | boolean | undefined>> =
  new (
    config: IntegrationConfig,
  ) => IntegrationBase & Integration

/**
 * Define a custom skelm integration.
 *
 * `defineIntegration` takes a plain options object and returns a class that
 * extends `IntegrationBase`. Instantiate that class with a standard
 * `IntegrationConfig` to get a fully functional integration you can register
 * with an `IntegrationRegistry` or load via the `plugins` array in
 * `skelm.config.ts`.
 *
 * @example
 * ```ts
 * import { defineIntegration } from '@skelm/integration-sdk'
 * import { z } from 'zod'
 *
 * export const NotionIntegration = defineIntegration({
 *   id: 'notion',
 *   name: 'Notion',
 *   capabilities: {
 *     canTrigger: false,
 *     canReceiveWebhooks: false,
 *     canPoll: true,
 *     canSendNotifications: true,
 *   },
 *   credentialsSchema: z.object({
 *     apiKey: z.string().min(1),
 *     databaseId: z.string().min(1),
 *   }),
 *   async performHealthCheck(creds) {
 *     // ping Notion API
 *     return true
 *   },
 *   async sendNotification(message, _opts, creds) {
 *     // create a Notion page
 *   },
 * })
 * ```
 */
export function defineIntegration<
  TCreds extends Record<string, string | number | boolean | undefined>,
>(options: DefineIntegrationOptions<TCreds>): IntegrationClass<TCreds> {
  class DefinedIntegration extends IntegrationBase {
    override readonly id = options.id
    override readonly name = options.name
    override readonly capabilities = options.capabilities

    /** Parsed + validated credentials, available after init() */
    private parsedCredentials: TCreds | null = null

    private get creds(): TCreds {
      if (this.parsedCredentials === null) {
        throw new IntegrationCredentialsError(
          `Integration "${options.id}" credentials accessed before init() — call init() first`,
        )
      }
      return this.parsedCredentials
    }

    protected override async validateCredentials(): Promise<void> {
      const result = options.credentialsSchema.safeParse(this.config.credentials)
      if (!result.success) {
        const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
        throw new IntegrationCredentialsError(
          `Invalid credentials for integration "${options.id}": ${messages.join('; ')}`,
        )
      }
      this.parsedCredentials = result.data as TCreds
      if (options.validateCredentials) {
        await options.validateCredentials(this.parsedCredentials, this.config)
      }
    }

    protected override async performHealthCheck(): Promise<boolean> {
      return options.performHealthCheck(this.creds, this.config)
    }

    protected override async setupWebhook(): Promise<void> {
      if (options.setupWebhook && this.config.webhook) {
        await options.setupWebhook(this.creds, this.config, this.config.webhook)
      }
    }

    protected override async cleanupWebhook(): Promise<void> {
      if (options.cleanupWebhook && this.config.webhook) {
        await options.cleanupWebhook(this.creds, this.config, this.config.webhook)
      }
    }

    async eventToRunInput(event: unknown): Promise<RunInput | null> {
      if (!options.eventToRunInput) return null
      return options.eventToRunInput(event, this.creds, this.config)
    }

    async sendNotification(message: string, opts?: Record<string, unknown>): Promise<void> {
      if (!options.sendNotification) {
        throw new IntegrationUnsupportedOperationError(
          `Integration "${options.id}" does not support sendNotification`,
        )
      }
      await options.sendNotification(message, opts, this.creds, this.config)
    }
  }

  return DefinedIntegration as IntegrationClass<TCreds>
}

// ---------------------------------------------------------------------------
// WorkflowPlugin adapter
// ---------------------------------------------------------------------------

/**
 * Wraps an `Integration` instance as a `WorkflowPlugin` so it can be loaded
 * by `PluginLoader` and registered in the `PluginRegistry`.
 *
 * You usually don't need to call this directly — `PluginLoader` does it
 * automatically when it detects an `Integration` default export.
 */
export function createIntegrationPlugin(integration: Integration): IntegrationWorkflowPlugin {
  return new IntegrationWorkflowPlugin(integration)
}

/** Sentinel symbol to identify wrapped integration plugins */
export const INTEGRATION_PLUGIN_BRAND = Symbol('skelm.IntegrationWorkflowPlugin')

export class IntegrationWorkflowPlugin {
  readonly [INTEGRATION_PLUGIN_BRAND] = true

  readonly id: string
  readonly name: string
  readonly version = '0.0.0'
  readonly type = 'workflow' as const
  state:
    | 'loading'
    | 'loaded'
    | 'initializing'
    | 'initialized'
    | 'starting'
    | 'active'
    | 'stopping'
    | 'stopped'
    | 'error' = 'loaded'

  private readonly integration: Integration
  private readonly eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>()

  constructor(integration: Integration) {
    this.integration = integration
    this.id = integration.id
    this.name = integration.name
  }

  async initialize(_config: Record<string, unknown>): Promise<void> {
    this.state = 'initialized'
  }

  async start(): Promise<void> {
    this.state = 'starting'
    await this.integration.init()
    this.state = 'active'
  }

  async stop(): Promise<void> {
    this.state = 'stopping'
    await this.integration.shutdown()
    this.state = 'stopped'
  }

  async healthCheck(): Promise<{
    healthy: boolean
    status: string
    lastCheck: string
    details?: Record<string, unknown>
    errors?: string[]
  }> {
    try {
      const healthy = await this.integration.healthCheck()
      return {
        healthy,
        status: healthy ? 'ok' : 'unhealthy',
        lastCheck: new Date().toISOString(),
      }
    } catch (error) {
      return {
        healthy: false,
        status: 'error',
        lastCheck: new Date().toISOString(),
        errors: [toErrorMessage(error)],
      }
    }
  }

  getMetadata() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      type: this.type,
      description: `Integration plugin wrapping ${this.integration.name}`,
      capabilities: Object.entries(this.integration.capabilities)
        .filter(([, v]) => v)
        .map(([k]) => k),
    }
  }

  getService(serviceName: string): unknown {
    if (serviceName === 'integration') return this.integration
    return undefined
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, [])
    this.eventHandlers.get(event)?.push(handler)
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.eventHandlers.get(event)
    if (!handlers) return
    const idx = handlers.indexOf(handler)
    if (idx >= 0) handlers.splice(idx, 1)
  }

  /** The underlying Integration instance */
  getIntegration(): Integration {
    return this.integration
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
