/**
 * Matrix trigger implementation
 *
 * Receives Matrix events via client SDK
 */

import { TriggerPluginBase } from './base.js'
import type { TriggerConfig, TriggerEvent, TriggerHealthStatus, TriggerType } from './types.js'

/**
 * Matrix event structure
 */
export interface MatrixEvent {
  type: string
  sender: string
  room_id: string
  content: {
    body?: string
    msgtype?: string
    [key: string]: unknown
  }
  origin_server_ts: number
  event_id: string
  [key: string]: unknown
}

/**
 * Matrix message event
 */
export interface MatrixMessageEvent extends MatrixEvent {
  type: 'm.room.message'
  content: {
    body: string
    msgtype: 'm.text' | 'm.emote' | 'm.notice'
    [key: string]: unknown
  }
}

/**
 * Matrix trigger configuration
 */
export interface MatrixTriggerConfig extends TriggerConfig {
  /** Matrix homeserver URL */
  homeserverUrl: string
  /** Matrix access token */
  accessToken: string
  /** Matrix user ID */
  userId: string
  /** Room IDs to listen to */
  roomIds: string[]
  /** Optional workflow ID to invoke */
  workflowId?: string
  /** Optional input data to pass to the workflow */
  input?: unknown
}

/**
 * Matrix trigger plugin
 *
 * Note: This is a simplified implementation. For production use,
 * consider using matrix-js-sdk for full client functionality.
 */
export class MatrixTrigger extends TriggerPluginBase {
  private isRunning = false

  constructor(id: string, name: string, description?: string) {
    super(id, name, '1.0.0', description)
  }

  override getTriggerType(): TriggerType {
    return 'matrix'
  }

  override async doInitialize(config: MatrixTriggerConfig): Promise<void> {
    // Validate required config
    if (!config.homeserverUrl) {
      throw new Error('Matrix trigger requires homeserverUrl')
    }
    if (!config.accessToken) {
      throw new Error('Matrix trigger requires accessToken')
    }
    if (!config.userId) {
      throw new Error('Matrix trigger requires userId')
    }
    if (!config.roomIds || config.roomIds.length === 0) {
      throw new Error('Matrix trigger requires at least one roomId')
    }

    this.config = config
    this.logger.info(`Initialized Matrix trigger for ${config.userId}`)
  }

  override async doStart(): Promise<void> {
    const config = this.config as MatrixTriggerConfig | null
    if (!config) {
      throw new Error('Matrix trigger not initialized')
    }

    this.isRunning = true
    this.logger.info(`Matrix trigger started, listening to ${config.roomIds.length} rooms`)

    // In a real implementation, this would:
    // 1. Create a Matrix client
    // 2. Sync with the server
    // 3. Listen for events in the specified rooms
    // 4. Filter events based on configuration

    // For now, we just mark as running
    // The actual event processing would happen via processEvent()
  }

  override async doStop(): Promise<void> {
    this.isRunning = false
    this.logger.info('Matrix trigger stopped')
  }

  override async doHealthCheck(): Promise<TriggerHealthStatus> {
    const config = this.config as MatrixTriggerConfig | null
    return {
      healthy: config !== null && this.isRunning,
      status: this.isRunning ? 'listening' : 'not-running',
      details: {
        userId: config?.userId,
        roomCount: config?.roomIds.length || 0,
        homeserver: config?.homeserverUrl,
      },
    }
  }

  /**
   * Process a Matrix event
   */
  async processEvent(event: MatrixEvent): Promise<void> {
    const config = this.config as MatrixTriggerConfig | null
    if (!config) {
      throw new Error('Matrix trigger not initialized')
    }

    // Check if event is from a monitored room
    if (!config.roomIds.includes(event.room_id)) {
      this.logger.debug(`Ignoring event from unmonitored room: ${event.room_id}`)
      return
    }

    // Skip events from self
    if (event.sender === config.userId) {
      this.logger.debug(`Ignoring own event: ${event.event_id}`)
      return
    }

    // Create trigger event
    const triggerEvent: TriggerEvent = {
      eventId: event.event_id,
      triggerId: this.id,
      triggerType: 'matrix',
      timestamp: new Date(event.origin_server_ts),
      payload: {
        type: event.type,
        content: event.content,
      },
      metadata: {
        source: 'matrix',
        matrixEventType: event.type,
        matrixEventId: event.event_id,
        matrixRoomId: event.room_id,
        matrixSender: event.sender,
        ...(config.workflowId !== undefined && { workflowId: config.workflowId }),
      },
    }

    // Emit trigger event
    await this.emitEvent(triggerEvent)

    // Log message events
    if (event.type === 'm.room.message' && 'body' in event.content) {
      this.logger.debug(
        `Matrix message from ${event.sender} in ${event.room_id}: ${event.content.body}`,
      )
    }
  }

  /**
   * Process a Matrix message event
   */
  async processMessage(event: MatrixMessageEvent): Promise<void> {
    await this.processEvent(event)
  }

  /**
   * Get the configured rooms
   */
  getRoomIds(): string[] {
    const config = this.config as MatrixTriggerConfig | null
    return config?.roomIds || []
  }
}

/**
 * Create a Matrix trigger
 */
export function createMatrixTrigger(id: string, name: string, description?: string): MatrixTrigger {
  return new MatrixTrigger(id, name, description)
}
