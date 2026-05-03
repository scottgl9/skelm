/**
 * Types for workflow plugins
 */

import type { TriggerEvent } from '../triggers/types.js'

/**
 * Workflow plugin configuration
 */
export interface WorkflowConfig {
  /** Unique identifier for this workflow */
  id: string
  /** Human-readable name */
  name: string
  /** Plugin version */
  version?: string
  /** Description of what this workflow does */
  description?: string
  /** Whether the workflow is enabled */
  enabled?: boolean
  /** Log level for debugging */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  /** Plugin-specific configuration */
  [key: string]: unknown
}

/**
 * Workflow execution result
 */
export interface WorkflowExecutionResult {
  /** Unique ID for this execution */
  executionId: string
  /** ID of the workflow that was executed */
  workflowId: string
  /** Whether the execution succeeded */
  success: boolean
  /** Result data if successful */
  data?: unknown
  /** Error if failed */
  error?: string
  /** When the execution started */
  startedAt: Date
  /** When the execution completed */
  completedAt: Date
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Health status for a workflow
 */
export interface WorkflowHealthStatus {
  /** Whether the workflow is healthy */
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

/**
 * Invocation of a workflow from a trigger
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
