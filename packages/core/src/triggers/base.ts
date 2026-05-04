/**
 * Abstract base class for trigger plugins
 *
 * Common functionality for trigger plugins:
 * - Lifecycle management
 * - Event handling
 * - Error handling
 * - Logging
 * - Config validation
 */

import type {
  TriggerConfig,
  TriggerEvent,
  TriggerEventHandler,
  TriggerHealthStatus,
  TriggerType,
} from './types.js'

/**
 * Base error for trigger-related errors
 */
export class TriggerError extends Error {
  override readonly name: string = 'TriggerError'
  public override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause
  }
}

export class TriggerInitializationError extends TriggerError {
  override readonly name: string = 'TriggerInitializationError'
}

export class TriggerStartError extends TriggerError {
  override readonly name: string = 'TriggerStartError'
}

export class TriggerStopError extends TriggerError {
  override readonly name: string = 'TriggerStopError'
}

export class TriggerValidationError extends TriggerError {
  override readonly name: string = 'TriggerValidationError'
}

/**
 * Trigger plugin states
 */
export enum TriggerState {
  /** Initial state before initialization */
  IDLE = 'idle',
  /** Initializing */
  INITIALIZING = 'initializing',
  /** Initialized but not started */
  INITIALIZED = 'initialized',
  /** Starting */
  STARTING = 'starting',
  /** Running */
  ACTIVE = 'active',
  /** Stopping */
  STOPPING = 'stopping',
  /** Stopped */
  STOPPED = 'stopped',
  /** Error state */
  ERROR = 'error',
}

/**
 * Abstract base class for trigger plugins
 */
export abstract class TriggerPluginBase {
  /** Unique identifier for this trigger */
  readonly id: string

  /** Human-readable name */
  readonly name: string

  /** Plugin version */
  readonly version: string

  /** Description of what this trigger does */
  readonly description?: string

  /** Current state */
  protected state: TriggerState = TriggerState.IDLE

  /** Whether the trigger is enabled */
  enabled = true

  /** Log level */
  protected logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info'

  /** Event handlers */
  protected readonly handlers: TriggerEventHandler[] = []

  /** Logger function */
  protected logger: {
    debug: (msg: string, ...args: unknown[]) => void
    info: (msg: string, ...args: unknown[]) => void
    warn: (msg: string, ...args: unknown[]) => void
    error: (msg: string, ...args: unknown[]) => void
  }

  /** Configuration */
  protected config: TriggerConfig | null = null

  /** Optional workflow executor for invoking workflows */
  private workflowExecutor?: {
    execute: (
      invocation: import('../workflows/types.js').WorkflowInvocation,
    ) => Promise<import('../workflows/types.js').WorkflowExecutionResult>
  }

  constructor(id: string, name: string, version = '1.0.0', description?: string) {
    this.id = id
    this.name = name
    this.version = version
    if (description !== undefined) {
      this.description = description
    }

    // Set up logger
    this.logger = {
      debug: (msg: string, ...args: unknown[]) => {
        if (this.logLevel === 'debug') {
          console.debug(`[Trigger:${this.id}] ${msg}`, ...args)
        }
      },
      info: (msg: string, ...args: unknown[]) => {
        if (this.logLevel === 'debug' || this.logLevel === 'info') {
          console.info(`[Trigger:${this.id}] ${msg}`, ...args)
        }
      },
      warn: (msg: string, ...args: unknown[]) => {
        if (this.logLevel !== 'error') {
          console.warn(`[Trigger:${this.id}] ${msg}`, ...args)
        }
      },
      error: (msg: string, ...args: unknown[]) => {
        console.error(`[Trigger:${this.id}] ${msg}`, ...args)
      },
    }
  }

  /**
   * Set the workflow executor for this trigger
   */
  setWorkflowExecutor(executor: {
    execute: (
      invocation: import('../workflows/types.js').WorkflowInvocation,
    ) => Promise<import('../workflows/types.js').WorkflowExecutionResult>
  }): void {
    this.workflowExecutor = executor
  }

  /**
   * Get the trigger type
   */
  abstract getTriggerType(): TriggerType

  /**
   * Initialize the trigger with configuration
   */
  async initialize(config: TriggerConfig): Promise<void> {
    if (this.state !== TriggerState.IDLE && this.state !== TriggerState.ERROR) {
      throw new TriggerInitializationError(`Cannot initialize trigger in state: ${this.state}`)
    }

    this.state = TriggerState.INITIALIZING
    this.config = config
    this.enabled = config.enabled ?? true
    this.logLevel = config.logLevel ?? 'info'

    try {
      // Validate configuration
      this.validateConfig(config)

      // Call subclass initialization
      await this.doInitialize(config)

      this.state = TriggerState.INITIALIZED
      this.logger.info(`Trigger initialized: ${this.id}`)
    } catch (error) {
      this.state = TriggerState.ERROR
      this.logger.error(
        `Failed to initialize trigger: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  /**
   * Start the trigger
   */
  async start(): Promise<void> {
    if (this.state !== TriggerState.INITIALIZED && this.state !== TriggerState.STOPPED) {
      throw new TriggerStartError(`Cannot start trigger in state: ${this.state}`)
    }

    this.state = TriggerState.STARTING

    try {
      await this.doStart()
      this.state = TriggerState.ACTIVE
      this.logger.info(`Trigger started: ${this.id}`)
    } catch (error) {
      this.state = TriggerState.ERROR
      this.logger.error(
        `Failed to start trigger: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw new TriggerStartError(
        `Failed to start trigger: ${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }
  }

  /**
   * Stop the trigger
   */
  async stop(): Promise<void> {
    if (this.state !== TriggerState.ACTIVE && this.state !== TriggerState.STARTING) {
      this.logger.warn(`Attempted to stop trigger in state: ${this.state}`)
      return
    }

    this.state = TriggerState.STOPPING

    try {
      await this.doStop()
      this.state = TriggerState.STOPPED
      this.logger.info(`Trigger stopped: ${this.id}`)
    } catch (error) {
      this.state = TriggerState.ERROR
      this.logger.error(
        `Failed to stop trigger: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw new TriggerStopError(
        `Failed to stop trigger: ${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }
  }

  /**
   * Check if the trigger is running
   */
  get isActive(): boolean {
    return this.state === TriggerState.ACTIVE
  }

  /**
   * Check if the trigger is initialized
   */
  get isInitialized(): boolean {
    return this.state === TriggerState.INITIALIZED || this.state === TriggerState.ACTIVE
  }

  /**
   * Add an event handler
   */
  onEvent(handler: TriggerEventHandler): void {
    this.handlers.push(handler)
  }

  /**
   * Remove an event handler
   */
  removeHandler(handler: TriggerEventHandler): void {
    const index = this.handlers.indexOf(handler)
    if (index !== -1) {
      this.handlers.splice(index, 1)
    }
  }

  /**
   * Emit an event to all handlers
   */
  protected async emitEvent(event: TriggerEvent): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`Trigger disabled, skipping event: ${event.eventId}`)
      return
    }

    this.logger.debug(`Emitting event: ${event.eventId}`)

    // Invoke workflow if configured
    const workflowId = this.config?.workflowId as string | undefined
    if (workflowId && this.workflowExecutor) {
      this.logger.debug(`Invoking workflow: ${workflowId}`)
      try {
        const invocation: import('../workflows/types.js').WorkflowInvocation = {
          workflowId,
          triggerEvent: event,
          input: this.config?.input as unknown,
        }

        const context: Record<string, unknown> = {}
        if (event.metadata.userId) context.userId = event.metadata.userId
        if (event.metadata.channelId) context.channelId = event.metadata.channelId
        if (event.metadata.correlationId) context.correlationId = event.metadata.correlationId

        if (Object.keys(context).length > 0) {
          invocation.context = context
        }

        await this.workflowExecutor.execute(invocation)
      } catch (error) {
        this.logger.error(
          `Workflow invocation error: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const promises = this.handlers.map(async (handler) => {
      try {
        await handler(event)
      } catch (error) {
        this.logger.error(
          `Handler error for event ${event.eventId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })

    await Promise.all(promises)
  }

  /**
   * Check trigger health
   */
  async healthCheck(): Promise<TriggerHealthStatus> {
    if (this.state === TriggerState.ERROR) {
      return {
        healthy: false,
        status: 'error',
        lastCheck: new Date(),
      }
    }

    if (this.state !== TriggerState.ACTIVE) {
      return {
        healthy: false,
        status: 'not-running',
        lastCheck: new Date(),
      }
    }

    try {
      const status = await this.doHealthCheck()
      return {
        ...status,
        lastCheck: new Date(),
      }
    } catch (error) {
      return {
        healthy: false,
        status: 'health-check-failed',
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Subclass hook for custom initialization
   */
  protected abstract doInitialize(config: TriggerConfig): Promise<void>

  /**
   * Subclass hook for starting the trigger
   */
  protected abstract doStart(): Promise<void>

  /**
   * Subclass hook for stopping the trigger
   */
  protected abstract doStop(): Promise<void>

  /**
   * Subclass hook for health checks
   */
  protected doHealthCheck(): Promise<TriggerHealthStatus> {
    return Promise.resolve({
      healthy: true,
      status: 'healthy',
    })
  }

  /**
   * Subclass hook for config validation
   */
  protected validateConfig(config: TriggerConfig): void {
    // Default: no validation
    if (!config.id) {
      throw new TriggerValidationError('Trigger config requires an id')
    }
  }
}
