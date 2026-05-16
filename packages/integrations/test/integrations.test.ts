import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubIntegration } from '../src/github.js'
import { IntegrationRegistry } from '../src/registry.js'
import { SlackIntegration } from '../src/slack.js'
import type { GitHubConfig, SlackConfig } from '@skelm/integration-sdk'

describe('IntegrationRegistry', () => {
  let registry: IntegrationRegistry

  beforeEach(async () => {
    registry = new IntegrationRegistry()
  })

  afterEach(async () => {
    await registry.shutdown()
  })

  it('creates an empty registry', () => {
    expect(registry.list()).toHaveLength(0)
    expect(registry.listEnabled()).toHaveLength(0)
  })

  it('registers and retrieves an integration', async () => {
    const githubConfig: GitHubConfig = {
      id: 'github',
      name: 'GitHub',
      enabled: true,
      credentials: {
        token: 'ghp_testtoken',
        ownerId: 'test-owner',
        repoName: 'test-repo',
      },
    }

    const github = new GitHubIntegration(githubConfig)
    await registry.register(github)

    expect(registry.has('github')).toBe(true)
    expect(registry.get('github')).toBe(github)
    expect(registry.list()).toHaveLength(1)
  })

  it('unregisters an integration', async () => {
    const githubConfig: GitHubConfig = {
      id: 'github',
      name: 'GitHub',
      enabled: true,
      credentials: {
        token: 'ghp_testtoken',
        ownerId: 'test-owner',
        repoName: 'test-repo',
      },
    }

    const github = new GitHubIntegration(githubConfig)
    await registry.register(github)
    await registry.unregister('github')

    expect(registry.has('github')).toBe(false)
    expect(registry.list()).toHaveLength(0)
  })

  it('filters enabled integrations', async () => {
    const githubEnabled: GitHubConfig = {
      id: 'github',
      name: 'GitHub Enabled',
      enabled: true,
      credentials: {
        token: 'ghp_testtoken',
        ownerId: 'test-owner',
        repoName: 'test-repo',
      },
    }

    const slackConfig: SlackConfig = {
      id: 'slack',
      name: 'Slack Disabled',
      enabled: false,
      credentials: {
        botToken: 'xoxb-testtoken',
        signingSecret: 'secret',
      },
    }

    await registry.register(new GitHubIntegration(githubEnabled))
    await registry.register(new SlackIntegration(slackConfig))

    expect(registry.list()).toHaveLength(2)
    expect(registry.listEnabled()).toHaveLength(1)
    expect(registry.listEnabled()[0].id).toBe('github')
  })

  it('dispatches events to handlers', async () => {
    const handler1 = vi.fn().mockResolvedValue({ result: 'handler1' })
    const handler2 = vi.fn().mockResolvedValue({ result: 'handler2' })

    registry.onEvent('test-integration', handler1)
    registry.onEvent('test-integration', handler2)

    const results = await registry.dispatchEvent('test-integration', { type: 'test-event' })

    expect(handler1).toHaveBeenCalled()
    expect(handler2).toHaveBeenCalled()
    expect(results).toHaveLength(2)
  })

  it('handles missing integration gracefully', async () => {
    await expect(registry.handleWebhook('nonexistent', {})).rejects.toThrow('not found')
  })

  it('shuts down all integrations', async () => {
    const githubConfig: GitHubConfig = {
      id: 'github',
      name: 'GitHub',
      enabled: true,
      credentials: {
        token: 'ghp_testtoken',
        ownerId: 'test-owner',
        repoName: 'test-repo',
      },
    }

    const github = new GitHubIntegration(githubConfig)
    const shutdownSpy = vi.spyOn(github, 'shutdown')

    await registry.register(github)
    await registry.shutdown()

    expect(shutdownSpy).toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })
})

describe('GitHubIntegration', () => {
  it('creates a GitHub integration with valid config', () => {
    const config: GitHubConfig = {
      id: 'github',
      name: 'GitHub',
      enabled: true,
      credentials: {
        token: 'ghp_testtoken',
        ownerId: 'test-owner',
        repoName: 'test-repo',
      },
    }

    const github = new GitHubIntegration(config)

    expect(github.id).toBe('github')
    expect(github.name).toBe('GitHub')
    expect(github.capabilities.canTrigger).toBe(true)
    expect(github.capabilities.canReceiveWebhooks).toBe(true)
  })

  it('rejects invalid credentials', async () => {
    const config: GitHubConfig = {
      id: 'github',
      name: 'GitHub',
      enabled: true,
      credentials: {
        token: '',
        ownerId: 'test-owner',
        repoName: 'test-repo',
      },
    }

    const github = new GitHubIntegration(config)

    await expect(github.init()).rejects.toThrow('missing')
  })

  it('converts issue event to RunInput', async () => {
    const config: GitHubConfig = {
      id: 'github',
      name: 'GitHub',
      enabled: true,
      credentials: {
        token: 'ghp_testtoken',
        ownerId: 'test-owner',
        repoName: 'test-repo',
      },
    }

    const github = new GitHubIntegration(config)

    const event = {
      event: 'issues',
      payload: {
        action: 'opened',
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 42,
        title: 'Test issue',
        body: 'Issue body',
        labels: ['bug'],
        assignees: [],
      },
      signature: 'test-signature',
    }

    const result = await github.eventToRunInput(event)

    expect(result).not.toBeNull()
    expect(result?.trigger.type).toBe('github-issue')
    expect(result?.trigger.issueNumber).toBe(42)
  })
})

describe('SlackIntegration', () => {
  it('creates a Slack integration with valid config', () => {
    const config: SlackConfig = {
      id: 'slack',
      name: 'Slack',
      enabled: true,
      credentials: {
        botToken: 'xoxb-testtoken',
        signingSecret: 'test-secret',
        channelId: 'C123456',
      },
    }

    const slack = new SlackIntegration(config)

    expect(slack.id).toBe('slack')
    expect(slack.name).toBe('Slack')
    expect(slack.capabilities.canTrigger).toBe(true)
    expect(slack.capabilities.canSendNotifications).toBe(true)
  })

  it('rejects invalid bot token', async () => {
    const config: SlackConfig = {
      id: 'slack',
      name: 'Slack',
      enabled: true,
      credentials: {
        botToken: 'invalid-token',
        signingSecret: 'test-secret',
      },
    }

    const slack = new SlackIntegration(config)

    await expect(slack.init()).rejects.toThrow('Invalid')
  })

  it('converts message event to RunInput', async () => {
    const config: SlackConfig = {
      id: 'slack',
      name: 'Slack',
      enabled: true,
      credentials: {
        botToken: 'xoxb-testtoken',
        signingSecret: 'test-secret',
        channelId: 'C123456',
      },
    }

    const slack = new SlackIntegration(config)

    const event: SlackConfig = {
      id: 'slack',
      name: 'Slack',
      enabled: true,
      credentials: {
        botToken: 'xoxb-testtoken',
        signingSecret: 'test-secret',
      },
    } as SlackConfig

    // Mock event callback
    const messageEvent = {
      type: 'event_callback',
      team_id: 'T123456',
      api_app_id: 'A123456',
      channel_id: 'C123456',
      event: {
        type: 'message',
        user: 'U123456',
        text: 'Hello, bot!',
      },
    }

    const result = await slack.eventToRunInput(
      messageEvent as unknown as { type: string; event: unknown; channel_id: string },
    )

    expect(result).not.toBeNull()
    expect(result?.trigger.type).toBe('slack-message')
    expect(result?.trigger.text).toBe('Hello, bot!')
  })
})
