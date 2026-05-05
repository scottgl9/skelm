import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronTrigger } from '../../src/triggers/cron.js'
import { createDiscordTrigger } from '../../src/triggers/discord.js'
import { createGitHubTrigger } from '../../src/triggers/github.js'
import { createMatrixTrigger } from '../../src/triggers/matrix.js'
import { createSlackTrigger } from '../../src/triggers/slack.js'
import type { TriggerEvent } from '../../src/triggers/types.js'
import { createWebhookTrigger } from '../../src/triggers/webhook.js'
import { WorkflowExecutor } from '../../src/workflows/executor.js'
import { WorkflowRegistry } from '../../src/workflows/registry.js'
import type { WorkflowInvocation } from '../../src/workflows/types.js'

// Port counter for unique ports in tests
let portCounter = 3300

function getNextPort(): number {
  return portCounter++
}

/**
 * Full-stack integration tests with mocked network
 *
 * These tests validate the complete trigger → workflow flow
 * with mocked HTTP servers and API responses.
 */

describe('Full-Stack Integration Tests', () => {
  let httpServer: Server
  let workflowRegistry: WorkflowRegistry
  let workflowExecutor: WorkflowExecutor
  let capturedEvents: TriggerEvent[] = []

  beforeEach(() => {
    capturedEvents = []
    workflowRegistry = new WorkflowRegistry()
    workflowExecutor = new WorkflowExecutor(workflowRegistry)

    // Create a simple HTTP server for webhook testing
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200)
      res.end('OK')
    })
  })

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
    }
    await workflowRegistry.shutdown()
  })

  describe('WebhookTrigger → Workflow', () => {
    it('receives webhook and invokes workflow', async () => {
      const port = getNextPort()

      // Set up webhook trigger
      const trigger = createWebhookTrigger(`webhook-test-${Date.now()}`, 'Webhook Test')
      trigger.setWorkflowExecutor(workflowExecutor)

      await trigger.initialize({
        id: `webhook-test-${Date.now()}`,
        name: 'Webhook Test',
        port: port,
        path: '/test',
      })

      await trigger.start()

      // Verify server is running
      const health = await trigger.healthCheck()
      expect(health.healthy).toBe(true)
      expect(health.details?.port).toBe(port)

      await trigger.stop()
    })
  })

  describe('CronTrigger → Workflow', () => {
    it('schedules and emits events correctly', async () => {
      const trigger = createCronTrigger(`cron-test-${Date.now()}`, 'Cron Test')
      trigger.setWorkflowExecutor(workflowExecutor)

      // Initialize with cron schedule
      await trigger.initialize({
        id: `cron-test-${Date.now()}`,
        name: 'Cron Test',
        schedule: '0 * * * *',
      })

      expect(trigger.isInitialized).toBe(true)

      await trigger.start()
      expect(trigger.isActive).toBe(true)

      const health = await trigger.healthCheck()
      expect(health.healthy).toBe(true)
      expect(health.details?.schedule).toBe('0 * * * *')

      await trigger.stop()
      expect(trigger.isActive).toBe(false)
    })
  })

  describe('SlackTrigger Configuration', () => {
    it('validates Slack configuration requirements', async () => {
      const trigger = createSlackTrigger('slack-test', 'Slack Test')

      // Missing signingSecret
      await expect(
        trigger.initialize({
          id: 'slack-test',
          name: 'Slack Test',
          botToken: 'xoxb-test',
        } as Parameters<typeof trigger.initialize>[0]),
      ).rejects.toThrow(/signingSecret/)

      // Missing botToken
      await expect(
        trigger.initialize({
          id: 'slack-test',
          name: 'Slack Test',
          signingSecret: 'secret',
        } as Parameters<typeof trigger.initialize>[0]),
      ).rejects.toThrow(/botToken/)

      // Valid configuration
      await expect(
        trigger.initialize({
          id: 'slack-test',
          name: 'Slack Test',
          signingSecret: 'secret',
          botToken: 'xoxb-test',
        }),
      ).resolves.not.toThrow()
    })
  })

  describe('GitHubTrigger Configuration', () => {
    it('handles GitHub webhook configuration', async () => {
      const trigger = createGitHubTrigger('github-test', 'GitHub Test')

      await trigger.initialize({
        id: 'github-test',
        name: 'GitHub Test',
        port: 3101,
      })

      expect(trigger.isInitialized).toBe(true)

      await trigger.start()
      expect(trigger.isActive).toBe(true)

      const health = await trigger.healthCheck()
      expect(health.healthy).toBe(true)

      await trigger.stop()
    })
  })

  describe('DiscordTrigger Configuration', () => {
    it('validates Discord configuration requirements', async () => {
      const trigger = createDiscordTrigger('discord-test', 'Discord Test')

      // Missing botToken
      await expect(
        trigger.initialize({
          id: 'discord-test',
          name: 'Discord Test',
          clientId: 'client-123',
          channelIds: ['123'],
        } as Parameters<typeof trigger.initialize>[0]),
      ).rejects.toThrow(/botToken/)

      // Missing clientId
      await expect(
        trigger.initialize({
          id: 'discord-test',
          name: 'Discord Test',
          botToken: 'token',
          channelIds: ['123'],
        } as Parameters<typeof trigger.initialize>[0]),
      ).rejects.toThrow(/clientId/)

      // Empty channelIds
      await expect(
        trigger.initialize({
          id: 'discord-test',
          name: 'Discord Test',
          botToken: 'token',
          clientId: 'client-123',
          channelIds: [],
        }),
      ).rejects.toThrow(/at least one channelId/)

      // Valid configuration
      await expect(
        trigger.initialize({
          id: 'discord-test',
          name: 'Discord Test',
          botToken: 'token',
          clientId: 'client-123',
          channelIds: ['123', '456'],
        }),
      ).resolves.not.toThrow()
    })
  })

  describe('MatrixTrigger Configuration', () => {
    it('validates Matrix configuration requirements', async () => {
      const trigger = createMatrixTrigger('matrix-test', 'Matrix Test')

      // Missing homeserverUrl
      await expect(
        trigger.initialize({
          id: 'matrix-test',
          name: 'Matrix Test',
          accessToken: 'token',
          userId: '@user:server.com',
          roomIds: ['!room:server.com'],
        } as Parameters<typeof trigger.initialize>[0]),
      ).rejects.toThrow(/homeserverUrl/)

      // Missing accessToken
      await expect(
        trigger.initialize({
          id: 'matrix-test',
          name: 'Matrix Test',
          homeserverUrl: 'https://server.com',
          userId: '@user:server.com',
          roomIds: ['!room:server.com'],
        } as Parameters<typeof trigger.initialize>[0]),
      ).rejects.toThrow(/accessToken/)

      // Missing userId
      await expect(
        trigger.initialize({
          id: 'matrix-test',
          name: 'Matrix Test',
          homeserverUrl: 'https://server.com',
          accessToken: 'token',
          roomIds: ['!room:server.com'],
        } as Parameters<typeof trigger.initialize>[0]),
      ).rejects.toThrow(/userId/)

      // Empty roomIds
      await expect(
        trigger.initialize({
          id: 'matrix-test',
          name: 'Matrix Test',
          homeserverUrl: 'https://server.com',
          accessToken: 'token',
          userId: '@user:server.com',
          roomIds: [],
        }),
      ).rejects.toThrow(/at least one roomId/)

      // Valid configuration
      await expect(
        trigger.initialize({
          id: 'matrix-test',
          name: 'Matrix Test',
          homeserverUrl: 'https://server.com',
          accessToken: 'token',
          userId: '@user:server.com',
          roomIds: ['!room1:server.com', '!room2:server.com'],
        }),
      ).resolves.not.toThrow()
    })
  })

  describe('Trigger Registry Integration', () => {
    it('manages multiple triggers simultaneously', async () => {
      // Create multiple triggers with unique IDs and ports
      const cronTrigger = createCronTrigger(`multi-cron-${Date.now()}`, 'Multi Cron')
      const webhookTrigger = createWebhookTrigger(`multi-webhook-${Date.now()}`, 'Multi Webhook')

      await cronTrigger.initialize({
        id: `multi-cron-${Date.now()}`,
        name: 'Multi Cron',
        schedule: '0 * * * *',
      })

      await webhookTrigger.initialize({
        id: `multi-webhook-${Date.now()}`,
        name: 'Multi Webhook',
        port: getNextPort(),
      })

      // Start triggers individually
      await cronTrigger.start()
      await webhookTrigger.start()

      expect(cronTrigger.isActive).toBe(true)
      expect(webhookTrigger.isActive).toBe(true)

      // Stop triggers individually
      await cronTrigger.stop()
      await webhookTrigger.stop()

      expect(cronTrigger.isActive).toBe(false)
      expect(webhookTrigger.isActive).toBe(false)
    })
  })

  describe('Workflow Invocation Flow', () => {
    it('passes trigger event to workflow correctly', async () => {
      let capturedInvocation: WorkflowInvocation | null = null

      // Mock workflow that captures invocation
      class MockWorkflow extends (await import('../../src/workflows/base.js')).WorkflowPluginBase {
        override getPluginType(): 'workflow' {
          return 'workflow'
        }

        override async execute(invocation: WorkflowInvocation) {
          capturedInvocation = invocation
          return {
            executionId: 'mock-exec',
            workflowId: this.id,
            success: true,
            data: { captured: true },
            startedAt: new Date(),
            completedAt: new Date(),
          }
        }

        override async doInitialize() {}
        override async doHealthCheck() {
          return { healthy: true, status: 'healthy' }
        }
      }

      const workflow = new MockWorkflow('test-workflow', 'Test Workflow')
      await workflow.initialize({ id: 'test-workflow' })
      await workflow.start()
      workflowRegistry.register(workflow)

      // Set up trigger with workflow
      const trigger = createCronTrigger('invocation-test', 'Invocation Test')
      trigger.setWorkflowExecutor(workflowExecutor)

      await trigger.initialize({
        id: 'invocation-test',
        name: 'Invocation Test',
        schedule: '0 * * * *',
        workflowId: 'test-workflow',
        input: { test: 'data' },
      })

      // Manually emit event
      const mockEvent: TriggerEvent = {
        eventId: 'test-event',
        triggerId: 'invocation-test',
        triggerType: 'cron',
        timestamp: new Date(),
        payload: { scheduled: true },
        metadata: { source: 'cron' },
      }

      await (trigger as unknown as { emitEvent: (e: TriggerEvent) => Promise<void> }).emitEvent(
        mockEvent,
      )

      expect(capturedInvocation).not.toBeNull()
      expect(capturedInvocation?.workflowId).toBe('test-workflow')
      expect(capturedInvocation?.triggerEvent.eventId).toBe('test-event')
      expect(capturedInvocation?.input).toEqual({ test: 'data' })

      await workflow.stop()
    })
  })
})
