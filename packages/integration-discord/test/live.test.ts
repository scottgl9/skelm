/**
 * Opt-in live Discord test. Skips cleanly unless every env var in the
 * descriptor is present (SKELM_LIVE_DISCORD + bot token + test channel id).
 * Default CI never hits the network here.
 */

import type { Connection } from '@skelm/integration-sdk'
import { shouldRunLiveTest } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import { DISCORD_LIVE_TEST, DiscordAdapter } from '../src/index.js'

const run = shouldRunLiveTest(DISCORD_LIVE_TEST)

describe.skipIf(!run)('Discord live round-trip', () => {
  it('sends, edits, reacts to, and deletes a message', async () => {
    const channelId = process.env.SKELM_DISCORD_TEST_CHANNEL_ID as string
    // The token is read here ONLY to act as the gateway-supplied resolver in a
    // live test; the adapter itself never reads process.env.
    const token = process.env.SKELM_DISCORD_BOT_TOKEN as string
    const connection: Connection = {
      id: 'live',
      integrationId: 'discord',
      credentialSchemaId: 'discord',
      credentials: [{ kind: 'credential-ref', secretName: 'SKELM_DISCORD_BOT_TOKEN' }],
    }
    const adapter = new DiscordAdapter({
      egress: (host) => ({ allow: host === 'discord.com' }),
      tokenResolver: async () => token,
    })
    await adapter.connect(connection)

    const sent = await adapter.sendMessage({
      target: { conversationId: channelId },
      text: 'skelm live test — sending',
    })
    expect(sent.messageId).toBeTruthy()

    const edited = await adapter.editMessage(sent, {
      target: { conversationId: channelId },
      text: 'skelm live test — edited',
    })
    expect(edited.messageId).toBe(sent.messageId)

    await adapter.addReaction(sent, '👍')
    await adapter.deleteMessage(sent)
    await adapter.disconnect()
  })
})

describe('live gating', () => {
  it('is skipped without the required env (reported as skip)', () => {
    if (!run) {
      // eslint-disable-next-line no-console
      console.log('Discord live test skipped: set SKELM_LIVE_DISCORD + token + channel id to run')
    }
    expect(typeof run).toBe('boolean')
  })
})
