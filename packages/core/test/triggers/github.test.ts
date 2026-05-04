import { describe, expect, it, vi } from 'vitest'
import { TriggerState } from '../../src/triggers/base.js'
import { GitHubTrigger, createGitHubTrigger } from '../../src/triggers/github.js'
import type { TriggerConfig } from '../../src/triggers/types.js'

describe('GitHubTrigger', () => {
  describe('getTriggerType', () => {
    it('returns github type', () => {
      const trigger = createGitHubTrigger('github-type', 'Test GitHub')
      expect(trigger.getTriggerType()).toBe('github')
    })
  })

  describe('initialization', () => {
    it('initializes with valid config', async () => {
      const id = `github-valid-${Date.now()}`
      const trigger = createGitHubTrigger(id, 'Valid GitHub')
      await trigger.initialize({
        id,
        webhookSecret: 'test-secret',
        events: ['push', 'pull_request'],
      })

      expect(trigger.isInitialized).toBe(true)
      expect(trigger.state).toBe(TriggerState.INITIALIZED)

      await trigger.stop().catch(() => {})
    })

    it('initializes without webhook secret', async () => {
      const id = `github-nosecret-${Date.now()}`
      const trigger = createGitHubTrigger(id, 'No Secret GitHub')
      await trigger.initialize({
        id,
        events: ['push'],
      } as unknown as TriggerConfig)

      expect(trigger.isInitialized).toBe(true)

      await trigger.stop().catch(() => {})
    })

    it('initializes without events', async () => {
      const id = `github-noevents-${Date.now()}`
      const trigger = createGitHubTrigger(id, 'No Events GitHub')
      await trigger.initialize({
        id,
        webhookSecret: 'test-secret',
      } as unknown as TriggerConfig)

      expect(trigger.isInitialized).toBe(true)

      await trigger.stop().catch(() => {})
    })

    it('initializes with empty events array', async () => {
      const id = `github-empty-${Date.now()}`
      const trigger = createGitHubTrigger(id, 'Empty Events GitHub')
      await trigger.initialize({
        id,
        webhookSecret: 'test-secret',
        events: [],
      })

      expect(trigger.isInitialized).toBe(true)

      await trigger.stop().catch(() => {})
    })
  })

  describe('start/stop', () => {
    it('starts and listens for webhooks', async () => {
      const handler = vi.fn()
      const id = `github-start-${Date.now()}`
      const trigger = createGitHubTrigger(id, 'Start GitHub')
      await trigger.initialize({
        id,
        webhookSecret: 'test-secret',
        events: ['push'],
      })

      trigger.onEvent(handler)
      await trigger.start()

      expect(trigger.isActive).toBe(true)

      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })

    it('stops server on stop', async () => {
      const id = `github-stop-${Date.now()}`
      const trigger = createGitHubTrigger(id, 'Stop GitHub')
      await trigger.initialize({
        id,
        webhookSecret: 'test-secret',
        events: ['push'],
      })

      await trigger.start()
      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })
  })

  describe('health check', () => {
    it('returns healthy when running', async () => {
      const id = `github-health-${Date.now()}`
      const trigger = createGitHubTrigger(id, 'Health GitHub')
      await trigger.initialize({
        id,
        webhookSecret: 'test-secret',
        events: ['push'],
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.status).toBe('listening')

      await trigger.stop()
    })

    it('includes events in details', async () => {
      const id = `github-details-${Date.now()}`
      const trigger = createGitHubTrigger(id, 'Details GitHub')
      await trigger.initialize({
        id,
        webhookSecret: 'test-secret',
        events: ['push', 'pull_request', 'issues'],
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.details).toMatchObject({
        eventCount: 3,
      })

      await trigger.stop()
    })
  })

  describe('factory function', () => {
    it('creates GitHubTrigger instance', () => {
      const trigger = createGitHubTrigger('factory-test', 'Factory Test')

      expect(trigger).toBeInstanceOf(GitHubTrigger)
      expect(trigger.id).toBe('factory-test')
      expect(trigger.name).toBe('Factory Test')
      expect(trigger.getTriggerType()).toBe('github')
    })
  })
})
