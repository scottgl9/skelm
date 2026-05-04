import { describe, it, expect, vi } from 'vitest'
import { SlackTrigger, createSlackTrigger } from '../../src/triggers/slack.js'
import { TriggerState } from '../../src/triggers/base.js'
import type { TriggerConfig } from '../../src/triggers/types.js'

describe('SlackTrigger', () => {
  describe('getTriggerType', () => {
    it('returns slack type', () => {
      const trigger = createSlackTrigger('slack-type', 'Test Slack')
      expect(trigger.getTriggerType()).toBe('slack')
    })
  })

  describe('initialization', () => {
    it('initializes with valid config', async () => {
      const id = `slack-valid-${Date.now()}`
      const trigger = createSlackTrigger(id, 'Valid Slack')
      await trigger.initialize({
        id,
        signingSecret: 'test-secret',
        botToken: 'xoxb-test-token',
      })

      expect(trigger.isInitialized).toBe(true)
      expect(trigger.state).toBe(TriggerState.INITIALIZED)

      await trigger.stop().catch(() => {})
    })

    it('throws error for missing signing secret', async () => {
      const trigger = createSlackTrigger('slack-missing', 'Missing Slack')
      await expect(
        trigger.initialize({
          id: 'slack-missing',
          botToken: 'xoxb-test-token',
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Slack trigger requires signingSecret')
    })

    it('throws error for missing bot token', async () => {
      const trigger = createSlackTrigger('slack-notoken', 'No Token Slack')
      await expect(
        trigger.initialize({
          id: 'slack-notoken',
          signingSecret: 'test-secret',
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Slack trigger requires botToken')
    })
  })

  describe('start/stop', () => {
    it('starts and connects to Slack', async () => {
      const handler = vi.fn()
      const id = `slack-start-${Date.now()}`
      const trigger = createSlackTrigger(id, 'Start Slack')
      await trigger.initialize({
        id,
        signingSecret: 'test-secret',
        botToken: 'xoxb-test-token',
      })

      trigger.onEvent(handler)
      await trigger.start()

      expect(trigger.isActive).toBe(true)

      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })

    it('disconnects on stop', async () => {
      const id = `slack-stop-${Date.now()}`
      const trigger = createSlackTrigger(id, 'Stop Slack')
      await trigger.initialize({
        id,
        signingSecret: 'test-secret',
        botToken: 'xoxb-test-token',
      })

      await trigger.start()
      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })
  })

  describe('health check', () => {
    it('returns healthy when running', async () => {
      const id = `slack-health-${Date.now()}`
      const trigger = createSlackTrigger(id, 'Health Slack')
      await trigger.initialize({
        id,
        signingSecret: 'test-secret',
        botToken: 'xoxb-test-token',
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.status).toBe('configured')

      await trigger.stop()
    })

    it('includes signingSecret in details', async () => {
      const id = `slack-details-${Date.now()}`
      const trigger = createSlackTrigger(id, 'Details Slack')
      await trigger.initialize({
        id,
        signingSecret: 'test-secret',
        botToken: 'xoxb-test-token',
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.details).toMatchObject({
        hasSigningSecret: true,
        hasBotToken: true,
      })

      await trigger.stop()
    })
  })

  describe('factory function', () => {
    it('creates SlackTrigger instance', () => {
      const trigger = createSlackTrigger('factory-test', 'Factory Test')

      expect(trigger).toBeInstanceOf(SlackTrigger)
      expect(trigger.id).toBe('factory-test')
      expect(trigger.name).toBe('Factory Test')
      expect(trigger.getTriggerType()).toBe('slack')
    })
  })
})
