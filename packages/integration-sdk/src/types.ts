/**
 * @skelm/integration-sdk — types
 *
 * Canonical type definitions for the skelm integration authoring surface.
 * All built-in integrations in @skelm/integrations and all third-party
 * integrations should use these types.
 */

/**
 * Input data for triggering a pipeline run.
 * Structure depends on the integration and event type.
 */
export type RunInput = Record<string, unknown>

/** Base integration configuration */
export interface IntegrationConfig {
  /** Integration identifier (e.g., 'github', 'slack') */
  id: string
  /** Display name */
  name: string
  /** Whether the integration is enabled */
  enabled: boolean
  /**
   * Authentication credentials. Values must be resolved from a SecretResolver
   * before being placed here — do not log, serialize to audit, or expose in
   * health-check output.
   */
  credentials: Record<string, string | number | boolean>
  /** Optional webhook configuration */
  webhook?: WebhookConfig
  /** Optional rate limiting config */
  rateLimit?: RateLimitConfig
}

/** Webhook configuration */
export interface WebhookConfig {
  /** Webhook path (e.g., '/webhooks/github') */
  path: string
  /** Secret for signature verification */
  secret?: string
  /** Event types to listen for */
  events: string[]
}

/** Rate limiting configuration */
export interface RateLimitConfig {
  /** Requests per window */
  requests: number
  /** Window duration in milliseconds */
  windowMs: number
}

/** Integration capability flags */
export interface IntegrationCapabilities {
  /** Can trigger pipeline runs */
  canTrigger: boolean
  /** Can receive webhooks */
  canReceiveWebhooks: boolean
  /** Can poll for changes */
  canPoll: boolean
  /** Can send notifications */
  canSendNotifications: boolean
}

/** Base integration interface */
export interface Integration {
  /** Integration identifier */
  readonly id: string
  /** Integration name */
  readonly name: string
  /** Capabilities */
  readonly capabilities: IntegrationCapabilities
  /** Configuration */
  config: IntegrationConfig

  /** Initialize the integration (validate credentials, setup webhooks) */
  init(): Promise<void>

  /** Shutdown the integration (cleanup webhooks, connections) */
  shutdown(): Promise<void>

  /** Check if the integration is healthy */
  healthCheck(): Promise<boolean>

  /** Convert external event to RunInput (if canTrigger) */
  eventToRunInput?(event: unknown): Promise<RunInput | null>

  /** Send notification (if canSendNotifications) */
  sendNotification?(message: string, options?: Record<string, unknown>): Promise<void>
}

// ---------------------------------------------------------------------------
// Provider-specific types — kept here so third-party authors can reference
// them without depending on @skelm/integrations.
// ---------------------------------------------------------------------------

/** GitHub-specific types */
export interface GitHubConfig extends IntegrationConfig {
  id: 'github'
  credentials: {
    token: string
    ownerId: string
    repoName: string
  }
}

export interface GitHubWebhookEvent {
  event: string
  payload: unknown
  signature: string
}

export interface GitHubIssueTrigger {
  owner: string
  repo: string
  issueNumber: number
  action: 'opened' | 'edited' | 'closed' | 'reopened'
  title: string
  body: string
  labels: string[]
  assignees: string[]
}

/** Slack-specific types */
export interface SlackConfig extends IntegrationConfig {
  id: 'slack'
  credentials: {
    botToken: string
    signingSecret: string
    channelId?: string
  }
}

export interface SlackWebhookEvent {
  type: 'event_callback' | 'url_verification' | 'block_actions'
  team_id: string
  api_app_id: string
  event: unknown
  challenge?: string
}

/** Jira-specific types */
export interface JiraConfig extends IntegrationConfig {
  id: 'jira'
  credentials: {
    host: string
    email: string
    apiToken: string
    projectId: string
  }
}

export interface JiraIssueTrigger {
  issueKey: string
  issueType: string
  summary: string
  description: string
  status: string
  priority: string
  assignee?: string
  reporter: string
  labels: string[]
  components: string[]
}

/** IMAP-specific types */
export interface IMAPConfig extends IntegrationConfig {
  id: 'imap'
  credentials: {
    host: string
    port: number
    user: string
    password: string
    tls: boolean
    folder: string
  }
  pollIntervalMs: number
  markAsRead: boolean
}

export interface EmailTrigger {
  messageId: string
  from: string
  to: string[]
  subject: string
  body: string
  htmlBody?: string
  attachments: Array<{ filename: string; contentType: string; size: number }>
  receivedAt: Date
}

/** Telegram-specific types */
export interface TelegramConfig extends IntegrationConfig {
  id: 'telegram'
  credentials: {
    botToken: string
    chatId?: string
  }
}

export interface TelegramWebhookEvent {
  update_id: number
  message?: unknown
  edited_message?: unknown
  callback_query?: unknown
}

export interface TelegramMessageTrigger {
  messageId: number
  chatId: string
  from: string
  text?: string
  entities?: Array<{ type: string; offset: number; length: number }>
  date: number
}

/**
 * Chat-UI-specific types. The chat UI (terminal or web) binds to a local
 * frontend and needs no credentials.
 */
export interface ChatUiConfig extends IntegrationConfig {
  id: 'chatui'
  credentials: Record<string, never>
}

/** Matrix-specific types */
export interface MatrixConfig extends IntegrationConfig {
  id: 'matrix'
  credentials: {
    /** Homeserver base URL, e.g. https://matrix.example.org */
    homeserverUrl: string
    /** Bot access token (Bearer). */
    accessToken: string
    /**
     * The bot's own user id (e.g. @bot:example.org). Used to drop the bot's own
     * timeline events so it doesn't reply to itself. Resolved via /whoami when omitted.
     */
    userId?: string
  }
}

export interface MatrixMessageTrigger {
  eventId: string
  roomId: string
  sender: string
  body: string
  date: number
}
