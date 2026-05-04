import { describe, expect, it, vi } from 'vitest'
import { TriggerState } from '../../src/triggers/base.js'
import { DiscordTrigger, createDiscordTrigger } from '../../src/triggers/discord.js'
import type { TriggerConfig } from '../../src/triggers/types.js'

describe('DiscordTrigger', () => {
  describe('getTriggerType', () => {
    it('returns discord type', () => {
      const trigger = createDiscordTrigger('discord-type', 'Test Discord')
      expect(trigger.getTriggerType()).toBe('discord')
    })
  })

  describe('initialization', () => {
    it('initializes with valid config', async () => {
      const id = `discord-valid-${Date.now()}`
      const trigger = createDiscordTrigger(id, 'Valid Discord')
      await trigger.initialize({
        id,
        botToken: 'test-bot-token',
        clientId: '123456789',
        channelIds: ['987654321'],
      })

      expect(trigger.isInitialized).toBe(true)
      expect(trigger.state).toBe(TriggerState.INITIALIZED)

      await trigger.stop().catch(() => {})
    })

    it('throws error for missing bot token', async () => {
      const trigger = createDiscordTrigger('discord-notoken', 'No Token Discord')
      await expect(
        trigger.initialize({
          id: 'discord-notoken',
          clientId: '123456789',
          channelIds: ['987654321'],
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Discord trigger requires botToken')
    })

    it('throws error for missing client ID', async () => {
      const trigger = createDiscordTrigger('discord-noclient', 'No Client Discord')
      await expect(
        trigger.initialize({
          id: 'discord-noclient',
          botToken: 'test-bot-token',
          channelIds: ['987654321'],
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Discord trigger requires clientId')
    })

    it('throws error for missing channel IDs', async () => {
      const trigger = createDiscordTrigger('discord-nochannels', 'No Channels Discord')
      await expect(
        trigger.initialize({
          id: 'discord-nochannels',
          botToken: 'test-bot-token',
          clientId: '123456789',
        } as unknown as TriggerConfig),
      ).rejects.toThrow('Discord trigger requires at least one channelId')
    })
  })

  describe('start/stop', () => {
    it('starts and connects to Discord', async () => {
      const handler = vi.fn()
      const id = `discord-start-${Date.now()}`
      const trigger = createDiscordTrigger(id, 'Start Discord')
      await trigger.initialize({
        id,
        botToken: 'test-bot-token',
        clientId: '123456789',
        channelIds: ['987654321'],
      })

      trigger.onEvent(handler)
      await trigger.start()

      expect(trigger.isActive).toBe(true)

      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })

    it('disconnects on stop', async () => {
      const id = `discord-stop-${Date.now()}`
      const trigger = createDiscordTrigger(id, 'Stop Discord')
      await trigger.initialize({
        id,
        botToken: 'test-bot-token',
        clientId: '123456789',
        channelIds: ['987654321'],
      })

      await trigger.start()
      await trigger.stop()
      expect(trigger.state).toBe(TriggerState.STOPPED)
    })
  })

  describe('health check', () => {
    it('returns healthy when running', async () => {
      const id = `discord-health-${Date.now()}`
      const trigger = createDiscordTrigger(id, 'Health Discord')
      await trigger.initialize({
        id,
        botToken: 'test-bot-token',
        clientId: '123456789',
        channelIds: ['987654321'],
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.status).toBe('listening')

      await trigger.stop()
    })

    it('includes channelIds in details', async () => {
      const id = `discord-details-${Date.now()}`
      const trigger = createDiscordTrigger(id, 'Details Discord')
      await trigger.initialize({
        id,
        botToken: 'test-bot-token',
        clientId: '123456789',
        channelIds: ['111222333'],
      })

      await trigger.start()
      const health = await trigger.healthCheck()

      expect(health.details).toMatchObject({
        channelCount: 1,
        clientId: '123456789',
      })

      await trigger.stop()
    })
  })

  describe('factory function', () => {
    it('creates DiscordTrigger instance', () => {
      const trigger = createDiscordTrigger('factory-test', 'Factory Test')

      expect(trigger).toBeInstanceOf(DiscordTrigger)
      expect(trigger.id).toBe('factory-test')
      expect(trigger.name).toBe('Factory Test')
      expect(trigger.getTriggerType()).toBe('discord')
    })
  })
})
