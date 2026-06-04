/**
 * Abstract base class for workflow plugins
 *
 * Common functionality for workflow plugins:
 * - Lifecycle management
 * - Error handling
 * - Logging
 * - Config validation
 */

import { toErrorMessage } from '../errors.js'
import type {
  WorkflowConfig,
  WorkflowExecutionResult,
  WorkflowHealthStatus,
  WorkflowInvocation,
} from './types.js'

/**
 * Base error for workflow-related errors
 */
export class WorkflowError extends Error {
  override readonly name: string = 'WorkflowError'
  public override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause
  }
}

export class WorkflowInitializationError extends WorkflowError {
  override readonly name: string = 'WorkflowInitializationError'
}

export class WorkflowExecutionError extends WorkflowError {
  override readonly name: string = 'WorkflowExecutionError'
}

export class WorkflowLifecycleError extends WorkflowError {
  override readonly name: string = 'WorkflowLifecycleError'
}

/**
 * Workflow plugin states
 */
export enum WorkflowState {
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
 * Abstract base class for workflow plugins
 */
export abstract class WorkflowPluginBase {
  /** Plugin ID */
  readonly id: string
  /** Plugin name */
  readonly name: string
  /** Plugin version */
  readonly version: string
  /** Plugin description */
  readonly description: string | undefined
  /** Current plugin state */
  protected state: WorkflowState = WorkflowState.IDLE
  /** Plugin configuration */
  protected config: WorkflowConfig | null = null
  /** Whether the plugin is enabled */
  protected enabled = true
  /** Logger */
  protected logger: Console = console

  constructor(id: string, name: string, version: string, description?: string) {
    this.id = id
    this.name = name
    this.version = version
    this.description = description
  }

  /**
   * Get the plugin type
   */
  abstract getPluginType(): 'workflow'

  /**
   * Initialize the plugin with configuration
   */
  async initialize(config: WorkflowConfig): Promise<void> {
    if (this.state !== WorkflowState.IDLE && this.state !== WorkflowState.ERROR) {
      throw new WorkflowInitializationError(`Cannot initialize workflow in state: ${this.state}`)
    }

    this.state = WorkflowState.INITIALIZING
    this.config = config
    this.enabled = config.enabled !== false
    this.logger = config.logLevel ? this.createLogger(config.logLevel) : this.logger

    try {
      await this.doInitialize(config)
      this.state = WorkflowState.INITIALIZED
      this.logger.info(`Workflow initialized: ${this.id}`)
    } catch (error) {
      this.state = WorkflowState.ERROR
      this.logger.error(
        `Failed to initialize workflow: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  /**
   * Start the workflow
   */
  async start(): Promise<void> {
    if (this.state !== WorkflowState.INITIALIZED) {
      throw new WorkflowLifecycleError(`Cannot start workflow in state: ${this.state}`)
    }

    this.state = WorkflowState.STARTING

    try {
      await this.doStart()
      this.state = WorkflowState.ACTIVE
      this.logger.info(`Workflow started: ${this.id}`)
    } catch (error) {
      this.state = WorkflowState.ERROR
      this.logger.error(`Failed to start workflow: ${toErrorMessage(error)}`)
      throw new WorkflowLifecycleError(`Failed to start workflow: ${toErrorMessage(error)}`, error)
    }
  }

  /**
   * Stop the workflow
   */
  async stop(): Promise<void> {
    if (this.state !== WorkflowState.ACTIVE && this.state !== WorkflowState.STARTING) {
      this.logger.warn(`Attempted to stop workflow in state: ${this.state}`)
      return
    }

    this.state = WorkflowState.STOPPING

    try {
      await this.doStop()
      this.state = WorkflowState.STOPPED
      this.logger.info(`Workflow stopped: ${this.id}`)
    } catch (error) {
      this.state = WorkflowState.ERROR
      this.logger.error(`Failed to stop workflow: ${toErrorMessage(error)}`)
      throw new WorkflowLifecycleError(`Failed to stop workflow: ${toErrorMessage(error)}`, error)
    }
  }

  /**
   * Check the health of the workflow
   */
  async healthCheck(): Promise<WorkflowHealthStatus> {
    try {
      const status = await this.doHealthCheck()
      return {
        ...status,
        lastCheck: new Date(),
      }
    } catch (error) {
      return {
        healthy: false,
        status: 'check-failed',
        error: toErrorMessage(error),
        lastCheck: new Date(),
      }
    }
  }

  /**
   * Execute a workflow invocation
   */
  abstract execute(invocation: WorkflowInvocation): Promise<WorkflowExecutionResult>

  /**
   * Override this method to perform initialization
   */
  protected abstract doInitialize(config: WorkflowConfig): Promise<void>

  /**
   * Override this method to perform startup
   */
  protected doStart(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Override this method to perform shutdown
   */
  protected doStop(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Override this method to provide health check details
   */
  protected doHealthCheck(): Promise<WorkflowHealthStatus> {
    return Promise.resolve({
      healthy: this.state === WorkflowState.ACTIVE,
      status: this.state,
    })
  }

  /**
   * Get the current state
   */
  getState(): WorkflowState {
    return this.state
  }

  /**
   * Check if the workflow is active
   */
  get isActive(): boolean {
    return this.state === WorkflowState.ACTIVE
  }

  /**
   * Check if the workflow is enabled
   */
  get isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Create a logger with the specified level
   */
  protected createLogger(level: 'debug' | 'info' | 'warn' | 'error'): Console {
    const prefix = `[Workflow:${this.id}]`
    const originalConsole = this.logger

    return {
      ...originalConsole,
      debug: (...args: unknown[]) => {
        if (level === 'debug') originalConsole.debug(prefix, ...args)
      },
      info: (...args: unknown[]) => {
        if (level !== 'error' && level !== 'warn') originalConsole.info(prefix, ...args)
      },
      warn: (...args: unknown[]) => {
        if (level !== 'error') originalConsole.warn(prefix, ...args)
      },
      error: (...args: unknown[]) => {
        originalConsole.error(prefix, ...args)
      },
    }
  }
}
