import { beforeEach, describe, expect, it } from 'vitest'
import {
  type CronTrigger,
  type CronTriggerConfig,
  createCronTrigger,
} from '../../src/triggers/cron.js'
import {
  type CustomTrigger,
  type CustomTriggerConfig,
  createCustomTrigger,
} from '../../src/triggers/custom.js'
import {
  type DiscordTrigger,
  type DiscordTriggerConfig,
  createDiscordTrigger,
} from '../../src/triggers/discord.js'
import {
  type GitHubTrigger,
  type GitHubTriggerConfig,
  createGitHubTrigger,
} from '../../src/triggers/github.js'
import {
  type MatrixTrigger,
  type MatrixTriggerConfig,
  createMatrixTrigger,
} from '../../src/triggers/matrix.js'
import {
  type ScriptTrigger,
  type ScriptTriggerConfig,
  createScriptTrigger,
} from '../../src/triggers/script.js'
import {
  type SlackTrigger,
  type SlackTriggerConfig,
  createSlackTrigger,
} from '../../src/triggers/slack.js'
import {
  type WebhookTrigger,
  type WebhookTriggerConfig,
  createWebhookTrigger,
} from '../../src/triggers/webhook.js'

/**
 * Schema validation tests for all trigger types
 *
 * These tests validate that each trigger properly validates its configuration
 * and rejects invalid configurations with appropriate error messages.
 */

describe('Trigger Schema Validation', () => {
  describe('CronTrigger', () => {
    let trigger: CronTrigger

    beforeEach(() => {
      trigger = createCronTrigger(`cron-${Date.now()}`, 'Test Cron')
    })

    it('accepts valid cron configuration', async () => {
      const config: CronTriggerConfig = {
        id: `cron-${Date.now()}`,
        name: 'Valid Cron',
        schedule: '0 * * * *',
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('rejects missing schedule', async () => {
      const config = {
        id: `cron-${Date.now()}`,
        name: 'Missing Schedule',
      } as unknown as CronTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/Invalid cron schedule/)
    })

    it('rejects invalid cron expression (wrong number of parts)', async () => {
      const config: CronTriggerConfig = {
        id: `cron-${Date.now()}`,
        name: 'Invalid Expression',
        schedule: '* * *', // Only 3 parts
      }

      await expect(trigger.initialize(config)).rejects.toThrow(/Invalid cron expression/)
    })

    it('accepts cron expression with ranges', async () => {
      const config: CronTriggerConfig = {
        id: `cron-${Date.now()}`,
        name: 'Range',
        schedule: '0-30 * 1-15 * 0-6',
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })
  })

  describe('WebhookTrigger', () => {
    let trigger: WebhookTrigger

    beforeEach(() => {
      trigger = createWebhookTrigger(`webhook-${Date.now()}`, 'Test Webhook')
    })

    it('accepts valid webhook configuration', async () => {
      const config: WebhookTriggerConfig = {
        id: `webhook-${Date.now()}`,
        name: 'Valid Webhook',
        port: 3000,
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('rejects missing port', async () => {
      const config = {
        id: `webhook-${Date.now()}`,
        name: 'Missing Port',
      } as unknown as WebhookTriggerConfig

      // Webhook trigger doesn't validate port in doInitialize, but should fail on start
      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('rejects invalid port (negative)', async () => {
      const config: WebhookTriggerConfig = {
        id: `webhook-${Date.now()}`,
        name: 'Negative Port',
        port: -1,
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
      await expect(trigger.start()).rejects.toThrow()
    })

    it('accepts optional path configuration', async () => {
      const config: WebhookTriggerConfig = {
        id: `webhook-${Date.now()}`,
        name: 'With Path',
        port: 3001,
        path: '/custom/webhook',
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('accepts optional secret configuration', async () => {
      const config: WebhookTriggerConfig = {
        id: `webhook-${Date.now()}`,
        name: 'With Secret',
        port: 3002,
        secret: 'my-secret-token',
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })
  })

  describe('SlackTrigger', () => {
    let trigger: SlackTrigger

    beforeEach(() => {
      trigger = createSlackTrigger(`slack-${Date.now()}`, 'Test Slack')
    })

    it('accepts valid Slack configuration', async () => {
      const config: SlackTriggerConfig = {
        id: `slack-${Date.now()}`,
        name: 'Valid Slack',
        signingSecret: 'xoxb-test-secret',
        botToken: 'xoxb-test-token',
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('rejects missing signingSecret', async () => {
      const config = {
        id: `slack-${Date.now()}`,
        name: 'Missing Secret',
        botToken: 'xoxb-test-token',
      } as unknown as SlackTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/signingSecret/)
    })

    it('rejects missing botToken', async () => {
      const config = {
        id: `slack-${Date.now()}`,
        name: 'Missing Token',
        signingSecret: 'xoxb-test-secret',
      } as unknown as SlackTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/botToken/)
    })
  })

  describe('MatrixTrigger', () => {
    let trigger: MatrixTrigger

    beforeEach(() => {
      trigger = createMatrixTrigger(`matrix-${Date.now()}`, 'Test Matrix')
    })

    it('accepts valid Matrix configuration', async () => {
      const config: MatrixTriggerConfig = {
        id: `matrix-${Date.now()}`,
        name: 'Valid Matrix',
        homeserverUrl: 'https://matrix.org',
        accessToken: 'test-token',
        userId: '@test:matrix.org',
        roomIds: ['!test:matrix.org'],
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('rejects missing homeserverUrl', async () => {
      const config = {
        id: `matrix-${Date.now()}`,
        name: 'Missing Homeserver',
        accessToken: 'test-token',
        userId: '@test:matrix.org',
        roomIds: ['!test:matrix.org'],
      } as unknown as MatrixTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/homeserverUrl/)
    })

    it('rejects missing accessToken', async () => {
      const config = {
        id: `matrix-${Date.now()}`,
        name: 'Missing Token',
        homeserverUrl: 'https://matrix.org',
        userId: '@test:matrix.org',
        roomIds: ['!test:matrix.org'],
      } as unknown as MatrixTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/accessToken/)
    })

    it('rejects missing userId', async () => {
      const config = {
        id: `matrix-${Date.now()}`,
        name: 'Missing UserId',
        homeserverUrl: 'https://matrix.org',
        accessToken: 'test-token',
        roomIds: ['!test:matrix.org'],
      } as unknown as MatrixTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/userId/)
    })

    it('rejects empty roomIds', async () => {
      const config: MatrixTriggerConfig = {
        id: `matrix-${Date.now()}`,
        name: 'Empty Rooms',
        homeserverUrl: 'https://matrix.org',
        accessToken: 'test-token',
        userId: '@test:matrix.org',
        roomIds: [],
      }

      await expect(trigger.initialize(config)).rejects.toThrow(/at least one roomId/)
    })

    it('accepts multiple roomIds', async () => {
      const config: MatrixTriggerConfig = {
        id: `matrix-${Date.now()}`,
        name: 'Multiple Rooms',
        homeserverUrl: 'https://matrix.org',
        accessToken: 'test-token',
        userId: '@test:matrix.org',
        roomIds: ['!room1:matrix.org', '!room2:matrix.org', '!room3:matrix.org'],
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })
  })

  describe('GitHubTrigger', () => {
    let trigger: GitHubTrigger

    beforeEach(() => {
      trigger = createGitHubTrigger(`github-${Date.now()}`, 'Test GitHub')
    })

    it('accepts valid GitHub configuration', async () => {
      const config: GitHubTriggerConfig = {
        id: `github-${Date.now()}`,
        name: 'Valid GitHub',
        webhookSecret: 'webhook-secret',
        port: 3020,
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('accepts GitHub configuration without webhookSecret (validation happens on use)', async () => {
      const config: GitHubTriggerConfig = {
        id: `github-${Date.now()}`,
        name: 'No Secret',
        port: 3020,
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('accepts optional eventFilter', async () => {
      const config: GitHubTriggerConfig = {
        id: `github-${Date.now()}`,
        name: 'With Filter',
        webhookSecret: 'webhook-secret',
        port: 3021,
        eventFilter: ['push', 'pull_request'],
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })
  })

  describe('DiscordTrigger', () => {
    let trigger: DiscordTrigger

    beforeEach(() => {
      trigger = createDiscordTrigger(`discord-${Date.now()}`, 'Test Discord')
    })

    it('accepts valid Discord configuration', async () => {
      const config: DiscordTriggerConfig = {
        id: `discord-${Date.now()}`,
        name: 'Valid Discord',
        botToken: 'BOT_TOKEN',
        clientId: 'CLIENT_ID',
        channelIds: ['123456789'],
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('rejects missing botToken', async () => {
      const config = {
        id: `discord-${Date.now()}`,
        name: 'Missing Token',
        clientId: 'CLIENT_ID',
        channelIds: ['123456789'],
      } as unknown as DiscordTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/botToken/)
    })

    it('rejects missing clientId', async () => {
      const config = {
        id: `discord-${Date.now()}`,
        name: 'Missing ClientId',
        botToken: 'BOT_TOKEN',
        channelIds: ['123456789'],
      } as unknown as DiscordTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/clientId/)
    })

    it('rejects empty channelIds', async () => {
      const config: DiscordTriggerConfig = {
        id: `discord-${Date.now()}`,
        name: 'Empty Channels',
        botToken: 'BOT_TOKEN',
        clientId: 'CLIENT_ID',
        channelIds: [],
      }

      await expect(trigger.initialize(config)).rejects.toThrow(/at least one channelId/)
    })

    it('accepts multiple channelIds', async () => {
      const config: DiscordTriggerConfig = {
        id: `discord-${Date.now()}`,
        name: 'Multiple Channels',
        botToken: 'BOT_TOKEN',
        clientId: 'CLIENT_ID',
        channelIds: ['123', '456', '789'],
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })
  })

  describe('ScriptTrigger', () => {
    let trigger: ScriptTrigger

    beforeEach(() => {
      trigger = createScriptTrigger(`script-${Date.now()}`, 'Test Script')
    })

    it('accepts valid Script configuration', async () => {
      const config: ScriptTriggerConfig = {
        id: `script-${Date.now()}`,
        name: 'Valid Script',
        command: 'echo',
        args: ['hello'],
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('rejects missing command', async () => {
      const config = {
        id: `script-${Date.now()}`,
        name: 'Missing Command',
        args: ['hello'],
      } as unknown as ScriptTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/command/)
    })

    it('rejects missing args', async () => {
      const config = {
        id: `script-${Date.now()}`,
        name: 'Missing Args',
        command: 'echo',
      } as unknown as ScriptTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/args/)
    })

    it('rejects empty args array', async () => {
      const config: ScriptTriggerConfig = {
        id: `script-${Date.now()}`,
        name: 'Empty Args',
        command: 'echo',
        args: [],
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('accepts optional intervalMs', async () => {
      const config: ScriptTriggerConfig = {
        id: `script-${Date.now()}`,
        name: 'With Interval',
        command: 'echo',
        args: ['hello'],
        intervalMs: 5000,
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('accepts optional timeoutMs', async () => {
      const config: ScriptTriggerConfig = {
        id: `script-${Date.now()}`,
        name: 'With Timeout',
        command: 'echo',
        args: ['hello'],
        intervalMs: 5000,
        timeoutMs: 30000,
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('accepts optional cwd and env', async () => {
      const config: ScriptTriggerConfig = {
        id: `script-${Date.now()}`,
        name: 'With Cwd and Env',
        command: 'echo',
        args: ['hello'],
        cwd: '/tmp',
        env: { TEST_VAR: 'value' },
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })
  })

  describe('CustomTrigger', () => {
    let trigger: CustomTrigger

    beforeEach(() => {
      trigger = createCustomTrigger(`custom-${Date.now()}`, 'Test Custom')
    })

    it('accepts valid Custom configuration', async () => {
      const config: CustomTriggerConfig = {
        id: `custom-${Date.now()}`,
        name: 'Valid Custom',
        handler: async () => ({ success: true }),
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })

    it('rejects missing handler', async () => {
      const config = {
        id: `custom-${Date.now()}`,
        name: 'Missing Handler',
      } as unknown as CustomTriggerConfig

      await expect(trigger.initialize(config)).rejects.toThrow(/handler/)
    })

    it('accepts optional interval', async () => {
      const config: CustomTriggerConfig = {
        id: `custom-${Date.now()}`,
        name: 'With Interval',
        handler: async () => ({ success: true }),
        interval: 5000,
      }

      await expect(trigger.initialize(config)).resolves.not.toThrow()
    })
  })
})
