import { describe, expect, it } from 'vitest'
import {
  DISCORD_MOCK_FIXTURE,
  type DiscordGatewayDispatch,
  type DiscordInteraction,
  normalizeGatewayDispatch,
  normalizeInteraction,
  parseSlashCommand,
} from '../src/index.js'

const fx = DISCORD_MOCK_FIXTURE.payloads

describe('normalizeGatewayDispatch', () => {
  it('normalizes MESSAGE_CREATE to a message event', () => {
    const event = normalizeGatewayDispatch(fx.messageCreate as DiscordGatewayDispatch)
    expect(event).not.toBeNull()
    expect(event?.type).toBe('message')
    expect(event?.provider).toBe('discord')
    expect(event?.target.conversationId).toBe('2222222222222222222')
    expect(event?.target.userId).toBe('3333333333333333333')
    expect(event?.text).toBe('hello from a fixture')
    expect(event?.messageId).toBe('1111111111111111111')
    // Snowflake-derived timestamp is after the Discord epoch.
    expect(event?.at).toBeGreaterThan(1420070400000)
  })

  it('normalizes MESSAGE_UPDATE to an edit event', () => {
    const dispatch = { ...(fx.messageCreate as DiscordGatewayDispatch), t: 'MESSAGE_UPDATE' }
    expect(normalizeGatewayDispatch(dispatch)?.type).toBe('edit')
  })

  it('normalizes MESSAGE_DELETE to a delete event', () => {
    const event = normalizeGatewayDispatch({
      t: 'MESSAGE_DELETE',
      d: { id: '1111111111111111111', channel_id: '2222222222222222222' },
    })
    expect(event?.type).toBe('delete')
    expect(event?.messageId).toBe('1111111111111111111')
  })

  it('normalizes MESSAGE_REACTION_ADD to a reaction event', () => {
    const event = normalizeGatewayDispatch(fx.reactionAdd as DiscordGatewayDispatch)
    expect(event?.type).toBe('reaction')
    expect(event?.reaction).toBe('👍')
    expect(event?.messageId).toBe('1111111111111111111')
    expect(event?.target.userId).toBe('3333333333333333333')
  })

  it('maps an image attachment to media kind image', () => {
    const event = normalizeGatewayDispatch({
      t: 'MESSAGE_CREATE',
      d: {
        id: '1',
        channel_id: '2',
        attachments: [
          { filename: 'a.png', content_type: 'image/png', url: 'https://cdn/x', size: 10 },
        ],
      },
    })
    expect(event?.attachments?.[0]?.kind).toBe('image')
    expect(event?.attachments?.[0]?.contentType).toBe('image/png')
  })

  it('returns null for unknown dispatch types', () => {
    expect(normalizeGatewayDispatch({ t: 'TYPING_START', d: {} })).toBeNull()
  })

  it('returns null when required ids are missing', () => {
    expect(normalizeGatewayDispatch({ t: 'MESSAGE_CREATE', d: { content: 'hi' } })).toBeNull()
  })
})

describe('parseSlashCommand', () => {
  it('flattens command name and options', () => {
    const parsed = parseSlashCommand(fx.slashCommand as DiscordInteraction)
    expect(parsed?.name).toBe('ping')
    expect(parsed?.options.target).toBe('world')
  })

  it('extracts a subcommand and its leaf options', () => {
    const interaction: DiscordInteraction = {
      id: '1',
      type: 2,
      channel_id: '2',
      data: {
        name: 'config',
        options: [{ name: 'set', type: 1, options: [{ name: 'key', type: 3, value: 'theme' }] }],
      },
    }
    const parsed = parseSlashCommand(interaction)
    expect(parsed?.subcommand).toBe('set')
    expect(parsed?.options.key).toBe('theme')
  })

  it('returns null for non-command interactions', () => {
    expect(parseSlashCommand({ type: 1 } as DiscordInteraction)).toBeNull()
  })
})

describe('normalizeInteraction', () => {
  it('normalizes a slash command to a command event', () => {
    const event = normalizeInteraction(fx.slashCommand as DiscordInteraction)
    expect(event?.type).toBe('command')
    expect(event?.command).toBe('ping')
    expect(event?.target.userId).toBe('3333333333333333333')
  })

  it('normalizes a button interaction to a callback event', () => {
    const event = normalizeInteraction(fx.buttonInteraction as DiscordInteraction)
    expect(event?.type).toBe('callback')
    expect(event?.callbackId).toBe('confirm_yes')
  })

  it('returns null for the PING handshake', () => {
    expect(normalizeInteraction(fx.ping as DiscordInteraction)).toBeNull()
  })

  it('prefers member.user.id then falls back to user.id', () => {
    const event = normalizeInteraction({
      id: '1',
      type: 3,
      channel_id: '2',
      user: { id: 'dm-user' },
      data: { custom_id: 'btn' },
    })
    expect(event?.target.userId).toBe('dm-user')
  })
})
