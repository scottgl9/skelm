import { defineIntegration } from '@skelm/integration-sdk'
import type { GitHubIssueTrigger, GitHubWebhookEvent } from '@skelm/integration-sdk'
import { z } from 'zod'

const githubCredentialsSchema = z.object({
  token: z.string().min(1, 'GitHub token is required'),
  ownerId: z.string().min(1, 'GitHub ownerId is required'),
  repoName: z.string().min(1, 'GitHub repoName is required'),
})

/**
 * GitHub integration for skelm pipelines.
 *
 * Supports:
 * - Issue/PR triggers
 * - Webhook event handling
 * - Repository polling
 * - Notifications via issue/PR comments
 */
export const GitHubIntegration = defineIntegration({
  id: 'github',
  name: 'GitHub',

  capabilities: {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: true,
    canSendNotifications: true,
  },

  credentialsSchema: githubCredentialsSchema,

  async validateCredentials(creds) {
    // Warn on unexpected token formats but don't hard-fail — fine-grained
    // tokens don't share the ghp_/gho_ prefixes.
    const { token } = creds
    if (!token.startsWith('ghp_') && !token.startsWith('gho_') && !token.startsWith('github_')) {
      console.warn('GitHub token does not match expected patterns (ghp_/gho_/github_)')
    }
  },

  async performHealthCheck(creds) {
    // In production: call GET /user or GET /repos/:owner/:repo
    return typeof creds.token === 'string' && creds.token.length > 0
  },

  async setupWebhook(_creds, config, webhook) {
    // In production: POST /repos/:owner/:repo/hooks
    console.log(`GitHub webhook would be registered at ${webhook.path} for ${config.name}`)
  },

  async cleanupWebhook() {
    // In production: DELETE /repos/:owner/:repo/hooks/:hook_id
    console.log('GitHub webhook would be unregistered')
  },

  async eventToRunInput(event, creds) {
    const { event: eventType, payload } = event as GitHubWebhookEvent

    if (eventType === 'issues') {
      const p = payload as GitHubIssueTrigger
      return {
        trigger: {
          type: 'github-issue',
          event: eventType,
          action: p.action,
          owner: p.owner ?? creds.ownerId,
          repo: p.repo ?? creds.repoName,
          issueNumber: p.issueNumber,
          title: p.title,
          body: p.body,
          labels: p.labels,
        },
      }
    }

    if (eventType === 'pull_request') {
      return { trigger: { type: 'github-pr', event: eventType, payload } }
    }

    if (eventType === 'push') {
      return { trigger: { type: 'github-push', event: eventType, payload } }
    }

    return null
  },

  async sendNotification(message, options) {
    // In production: POST /repos/:owner/:repo/issues/:issue_number/comments
    console.log(`GitHub notification: ${message}`, options)
  },
})

// Keep the type alias so callers can do `new GitHubIntegration(config)` and
// also reference `typeof GitHubIntegration` for type narrowing.
export type GitHubIntegrationType = InstanceType<typeof GitHubIntegration>
