/**
 * Slack trigger implementation
 * 
 * Receives Slack events via Bolt-like event handlers
 */

import { TriggerPluginBase } from './base.js'
import type { TriggerConfig, TriggerType, TriggerEvent, TriggerHealthStatus } from './types.js'

/**
 * Slack event payload structure
 */
export interface SlackEvent {
  type: string
  event_ts: string
  command?: string
  user_id?: string
  user_name?: string
  channel_id?: string
  channel_name?: string
  text?: string
  response_url?: string
  trigger_id?: string
  [key: string]: unknown
}

/**
 * Slack block action payload
 */
export interface SlackBlockAction {
  type: 'block_actions'
  user: { id: string; username: string }
  channel: { id: string; name: string }
  actions: Array<{ action_id: string; value?: string }>
  message?: { text: string }
  [key: string]: unknown
}

/**
 * Slack command payload
 */
export interface SlackCommand {
  command: string
  user_id: string
  user_name: string
  channel_id: string
  channel_name: string
  text: string
  response_url: string
  trigger_id: string
}

/**
 * Slack trigger configuration
 */
export interface SlackTriggerConfig extends TriggerConfig {
  /** Slack signing secret */
  signingSecret: string
  /** Slack bot token */
  botToken: string
  /** Port for Slack events (if using HTTP) */
  port?: number
  /** Slack event types to subscribe to */
  eventTypes?: string[]
  /** Optional workflow ID to invoke */
  workflowId?: string
  /** Optional input data to pass to the workflow */
  input?: unknown
}

/**
 * Slack trigger plugin
 * 
 * Note: This is a simplified implementation. For production use,
 * consider using @slack/bolt package for full event handling.
 */
export class SlackTrigger extends TriggerPluginBase {
  private eventHandlers: Map<string, ((event: SlackEvent) => Promise<void>)[]> = new Map()
  
  constructor(id: string, name: string, description?: string) {
    super(id, name, '1.0.0', description)
  }
  
  override getTriggerType(): TriggerType {
    return 'slack'
  }
  
  override async doInitialize(config: SlackTriggerConfig): Promise<void> {
    // Validate required config
    if (!config.signingSecret) {
      throw new Error('Slack trigger requires signingSecret')
    }
    if (!config.botToken) {
      throw new Error('Slack trigger requires botToken')
    }
    
    this.config = config
    this.logger.info('Initialized Slack trigger')
  }
  
  override async doStart(): Promise<void> {
    // In a real implementation, this would:
    // 1. Start an HTTP server for Slack events
    // 2. Verify Slack signing signatures
    // 3. Route events to appropriate handlers
    
    this.logger.info('Slack trigger started')
  }
  
  override async doStop(): Promise<void> {
    this.logger.info('Slack trigger stopped')
  }
  
  override async doHealthCheck(): Promise<TriggerHealthStatus> {
    const config = this.config
    return {
      healthy: config !== null,
      status: config ? 'configured' : 'not-configured',
      details: {
        hasSigningSecret: !!config?.signingSecret,
        hasBotToken: !!config?.botToken,
      },
    }
  }
  
  /**
   * Register an event handler for a specific event type
   */
  onSlackEvent(eventType: string, handler: (event: SlackEvent) => Promise<void>): void {
    const handlers = this.eventHandlers.get(eventType) || []
    handlers.push(handler)
    this.eventHandlers.set(eventType, handlers)
    
    this.logger.debug(`Registered handler for Slack event type: ${eventType}`)
  }
  
  /**
   * Process a Slack event
   */
  async processEvent(event: SlackEvent, context: {
    userId?: string
    channelId?: string
  }): Promise<void> {
    if (!this.config) {
      throw new Error('Slack trigger not initialized')
    }
    
    // Check if we have handlers for this event type
    const handlers = this.eventHandlers.get(event.type) || []
    
    if (handlers.length === 0) {
      this.logger.debug(`No handlers for Slack event type: ${event.type}`)
      return
    }
    
    // Create trigger event
    const triggerEvent: TriggerEvent = {
      eventId: `slack-${event.event_ts || Date.now()}`,
      triggerId: this.id,
      triggerType: 'slack',
      timestamp: new Date(),
      payload: event,
      metadata: {
        source: 'slack',
        slackEventType: event.type,
        slackEventTs: event.event_ts,
        ...context,
        ...(this.config && this.config.workflowId !== undefined && { workflowId: this.config.workflowId }),
      },
    }
    
    // Emit trigger event
    await this.emitEvent(triggerEvent)
    
    // Also call type-specific handlers
    for (const handler of handlers) {
      try {
        await handler(event)
      } catch (error) {
        this.logger.error(`Slack event handler error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  
  /**
   * Process a Slack block action
   */
  async processBlockAction(action: SlackBlockAction): Promise<void> {
    const { type, ...rest } = action
    const event: SlackEvent = {
      type: action.type,
      event_ts: String(Date.now()),
      ...rest,
    }
    
    await this.processEvent(event, {
      userId: action.user.id,
      channelId: action.channel.id,
    })
  }
  
  /**
   * Process a Slack command
   */
  async processCommand(command: SlackCommand): Promise<void> {
    const event: SlackEvent = {
      type: 'slash_command',
      event_ts: String(Date.now()),
      command: command.command,
      user_id: command.user_id,
      user_name: command.user_name,
      channel_id: command.channel_id,
      channel_name: command.channel_name,
      text: command.text,
      response_url: command.response_url,
      trigger_id: command.trigger_id,
      event_type: 'slash_command',
    }
    
    await this.processEvent(event, {
      userId: command.user_id,
      channelId: command.channel_id,
    })
  }
}

/**
 * Create a Slack trigger
 */
export function createSlackTrigger(id: string, name: string, description?: string): SlackTrigger {
  return new SlackTrigger(id, name, description)
}
