import { IntegrationBase } from './base.js'
import type { GitHubConfig, GitHubIssueTrigger, GitHubWebhookEvent } from './types.js'

/**
 * GitHub integration for skelm pipelines
 *
 * Supports:
 * - Issue/PR triggers
 * - Webhook event handling
 * - Repository polling
 */
export class GitHubIntegration extends IntegrationBase {
  override readonly id = 'github' as const
  override readonly name = 'GitHub'
  readonly capabilities = {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: true,
    canSendNotifications: true,
  }

  private apiBaseUrl = 'https://api.github.com'
  private octokit: unknown | null = null // Would use @octokit/rest in production

  constructor(config: GitHubConfig) {
    super(config)
  }

  protected async validateCredentials(): Promise<void> {
    const { token, ownerId, repoName } = this.config.credentials

    if (!token || !ownerId || !repoName) {
      throw new Error('GitHub credentials missing: token, ownerId, and repoName required')
    }

    // In production, validate the token with GitHub API
    // For now, we just check it exists and has reasonable format
    const tokenStr = String(token)
    if (
      !tokenStr.startsWith('ghp_') &&
      !tokenStr.startsWith('gho_') &&
      !tokenStr.startsWith('github_')
    ) {
      // Warning only - might be a fine-grained token
      console.warn('GitHub token does not match expected patterns')
    }
  }

  protected async performHealthCheck(): Promise<boolean> {
    try {
      // In production, make a simple API call to verify connectivity
      // For now, just check we have credentials
      return !!this.config.credentials.token
    } catch {
      return false
    }
  }

  protected async setupWebhook(): Promise<void> {
    const { webhook } = this.config
    if (!webhook) {
      return
    }

    // In production, register webhook with GitHub
    // This would use the GitHub API to create a repo webhook
    console.log(`GitHub webhook would be registered at ${webhook.path}`)
  }

  protected async cleanupWebhook(): Promise<void> {
    // In production, unregister webhook from GitHub
    console.log('GitHub webhook would be unregistered')
  }

  /**
   * Convert GitHub webhook event to RunInput
   */
  async eventToRunInput(event: GitHubWebhookEvent): Promise<Record<string, unknown> | null> {
    if (!this.capabilities.canTrigger) {
      return null
    }

    const { event: eventType, payload } = event

    // Handle issue events
    if (eventType === 'issues') {
      const issuePayload = payload as GitHubIssueTrigger
      return {
        trigger: {
          type: 'github-issue',
          event: eventType,
          action: issuePayload.action,
          owner: issuePayload.owner,
          repo: issuePayload.repo,
          issueNumber: issuePayload.issueNumber,
          title: issuePayload.title,
          body: issuePayload.body,
          labels: issuePayload.labels,
        },
      }
    }

    // Handle pull request events
    if (eventType === 'pull_request') {
      return {
        trigger: {
          type: 'github-pr',
          event: eventType,
          payload: payload,
        },
      }
    }

    // Handle push events
    if (eventType === 'push') {
      return {
        trigger: {
          type: 'github-push',
          event: eventType,
          payload: payload,
        },
      }
    }

    // Other events can be ignored or handled as needed
    return null
  }

  /**
   * Send notification to GitHub (issue comment, PR comment, etc.)
   */
  async sendNotification(
    message: string,
    options?: {
      issueNumber?: number
      prNumber?: number
      commentOn?: 'issue' | 'pr'
    },
  ): Promise<void> {
    // In production, use GitHub API to post comments
    console.log(`GitHub notification: ${message}`, options)
  }

  /**
   * Poll for new issues/PRs
   */
  async pollForChanges(since?: Date): Promise<unknown[]> {
    // In production, query GitHub API for changes
    console.log(`Polling GitHub for changes since ${since?.toISOString()}`)
    return []
  }

  /**
   * Get issue or PR details
   */
  async getIssueOrPr(owner: string, repo: string, number: number): Promise<unknown> {
    // In production, fetch from GitHub API
    console.log(`Fetching ${owner}/${repo}#${number}`)
    return {}
  }
}
