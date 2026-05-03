/**
 * Types for trigger plugins
 */

/**
 * Trigger types supported by skelm
 */
export type TriggerType = 'cron' | 'webhook' | 'slack' | 'matrix' | 'github' | 'discord' | 'email' | 'custom'

/**
 * Configuration for a trigger plugin
 */
export interface TriggerConfig {
  /** Unique identifier for this trigger */
  id: string
  /** Human-readable name */
  name: string
  /** Plugin version */
  version?: string
  /** Description of what this trigger does */
  description?: string
  /** Whether the trigger is enabled */
  enabled?: boolean
  /** Log level for debugging */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  /** ID of workflow to invoke when trigger fires */
  workflowId?: string
  /** Input data to pass to the workflow */
  input?: unknown
  /** Plugin-specific configuration */
  [key: string]: unknown
}

/**
 * Event emitted by a trigger
 */
export interface TriggerEvent {
  /** Unique ID for this event */
  eventId: string
  /** ID of the trigger that emitted this event */
  triggerId: string
  /** Type of trigger */
  triggerType: TriggerType
  /** When the event occurred */
  timestamp: Date
  /** Event payload */
  payload: unknown
  /** Additional metadata */
  metadata: {
    source: string
    correlationId?: string
    userId?: string
    channelId?: string
    [key: string]: unknown
  }
}

/**
 * Handler for trigger events
 */
export type TriggerEventHandler = (event: TriggerEvent) => Promise<void>

/**
 * Workflow invocation from a trigger
 */
export interface WorkflowInvocation {
  /** ID of the workflow to invoke */
  workflowId: string
  /** The trigger event that caused this invocation */
  triggerEvent: TriggerEvent
  /** Input data for the workflow */
  input?: unknown
  /** Execution context */
  context?: {
    userId?: string
    channelId?: string
    correlationId?: string
    [key: string]: unknown
  }
}

/**
 * Health status for a trigger
 */
export interface TriggerHealthStatus {
  /** Whether the trigger is healthy */
  healthy: boolean
  /** Status code */
  status: string
  /** Additional details */
  details?: Record<string, unknown>
  /** Last check timestamp */
  lastCheck?: Date
  /** Error message if unhealthy */
  error?: string
}
