/**
 * Declarative {@link IntegrationPackageManifest} for the Discord integration,
 * plus the credential schema (references only), provider health check, and the
 * canned mock fixture / live-test descriptor the gateway and self-test read.
 */

import type {
  ActionDefinition,
  Connection,
  CredentialSchema,
  EgressPolicy,
  IntegrationPackageManifest,
  LiveTestDescriptor,
  MockProviderFixture,
  ProviderHealthCheck,
  TriggerDefinition,
} from '@skelm/integration-sdk'
import { DISCORD_CAPABILITIES, type DiscordTokenResolver } from './adapter.js'
import { DiscordRestClient } from './rest.js'
import { DISCORD_PROVIDER } from './types.js'

/**
 * Credentials Discord requires — declared by name and shape only. The bot token
 * is a `token` field resolved by the gateway at dispatch; the package never
 * reads `process.env` for it and never holds the value.
 */
export const DISCORD_CREDENTIAL_SCHEMA: CredentialSchema = {
  id: DISCORD_PROVIDER,
  description: 'Discord bot credentials. Resolved by the gateway; never stored by the package.',
  fields: [
    {
      name: 'botToken',
      kind: 'token',
      description: 'Bot token from the Discord Developer Portal (Bot → Token).',
    },
    {
      name: 'publicKey',
      kind: 'string',
      description: 'Application public key (hex) used to verify Ed25519 interaction signatures.',
    },
  ],
}

export const DISCORD_ACTIONS: readonly ActionDefinition[] = [
  { id: 'sendMessage', description: 'Send a message to a channel or thread.' },
  { id: 'sendEmbed', description: 'Send a message with one or more embeds.' },
  { id: 'addReaction', description: 'Add a reaction to a message.' },
  { id: 'createThread', description: 'Create a thread from a message and post into it.' },
]

export const DISCORD_TRIGGERS: readonly TriggerDefinition[] = [
  {
    id: 'messageReceived',
    kind: 'event-source',
    description: 'A message was created in a watched channel.',
    events: ['MESSAGE_CREATE', 'MESSAGE_UPDATE'],
  },
  {
    id: 'slashCommand',
    kind: 'webhook',
    description: 'A registered slash command was invoked.',
    events: ['INTERACTION_CREATE:command'],
  },
  {
    id: 'reactionAdded',
    kind: 'event-source',
    description: 'A reaction was added to a message.',
    events: ['MESSAGE_REACTION_ADD'],
  },
  {
    id: 'buttonInteraction',
    kind: 'webhook',
    description: 'A message-component (button/select) interaction fired.',
    events: ['INTERACTION_CREATE:component'],
  },
]

/** Canned Discord payloads for deterministic CI. No real network or credentials. */
export const DISCORD_MOCK_FIXTURE: MockProviderFixture = {
  provider: DISCORD_PROVIDER,
  description: 'Canned Discord gateway dispatches and interaction payloads.',
  payloads: {
    messageCreate: {
      t: 'MESSAGE_CREATE',
      d: {
        id: '1111111111111111111',
        channel_id: '2222222222222222222',
        content: 'hello from a fixture',
        author: { id: '3333333333333333333', username: 'fixture-user' },
        attachments: [],
      },
    },
    reactionAdd: {
      t: 'MESSAGE_REACTION_ADD',
      d: {
        message_id: '1111111111111111111',
        channel_id: '2222222222222222222',
        user_id: '3333333333333333333',
        emoji: { name: '👍' },
      },
    },
    slashCommand: {
      id: '4444444444444444444',
      type: 2,
      channel_id: '2222222222222222222',
      member: { user: { id: '3333333333333333333' } },
      data: { name: 'ping', options: [{ name: 'target', type: 3, value: 'world' }] },
    },
    buttonInteraction: {
      id: '5555555555555555555',
      type: 3,
      channel_id: '2222222222222222222',
      member: { user: { id: '3333333333333333333' } },
      data: { custom_id: 'confirm_yes', component_type: 2 },
    },
    ping: { id: '6666666666666666666', type: 1 },
  },
}

export const DISCORD_LIVE_TEST: LiveTestDescriptor = {
  provider: DISCORD_PROVIDER,
  name: 'Discord live send/edit/react round-trip',
  description: 'Sends, edits, reacts to, and deletes a message in a test channel. Opt-in only.',
  requiredEnv: ['SKELM_LIVE_DISCORD', 'SKELM_DISCORD_BOT_TOKEN', 'SKELM_DISCORD_TEST_CHANNEL_ID'],
}

export const discordManifest: IntegrationPackageManifest = {
  name: '@skelm/integration-discord',
  version: '0.4.8',
  description:
    'Discord conversation adapter — messages, threads, reactions, buttons, and Ed25519-verified interactions.',
  actions: DISCORD_ACTIONS,
  triggers: DISCORD_TRIGGERS,
  conversationAdapters: [DISCORD_CAPABILITIES],
  credentials: [DISCORD_CREDENTIAL_SCHEMA],
  requiredPermissions: ['network'],
  webhooks: [
    {
      path: '/webhooks/discord/interactions',
      verification: 'signature-header',
      events: ['INTERACTION_CREATE:command', 'INTERACTION_CREATE:component'],
    },
  ],
  supportedEvents: [
    'MESSAGE_CREATE',
    'MESSAGE_UPDATE',
    'MESSAGE_DELETE',
    'MESSAGE_REACTION_ADD',
    'INTERACTION_CREATE:command',
    'INTERACTION_CREATE:component',
  ],
  dashboard: {
    title: 'Discord',
    fields: {
      botToken: { label: 'Bot Token', secret: true },
      publicKey: { label: 'Application Public Key', secret: false },
    },
  },
  mockFixtures: [DISCORD_MOCK_FIXTURE],
  liveTests: [DISCORD_LIVE_TEST],
  auditRedaction: {
    redactPaths: ['credentials.botToken', 'headers.authorization', 'token'],
  },
}

/**
 * Liveness/credential check: calls `GET /users/@me` through the egress-gated
 * REST client. Never includes a secret value in `detail`.
 */
export async function discordHealthCheck(args: {
  readonly connection: Connection
  readonly egress: EgressPolicy
  readonly tokenResolver: DiscordTokenResolver
  readonly fetchImpl?: typeof fetch
}): Promise<ProviderHealthCheck> {
  const checkedAt = new Date().toISOString()
  try {
    const botToken = await args.tokenResolver(args.connection)
    const client = new DiscordRestClient({
      botToken,
      egress: args.egress,
      ...(args.fetchImpl !== undefined ? { fetchImpl: args.fetchImpl } : {}),
      maxAttempts: 1,
    })
    await client.request<{ id: string }>('GET', '/users/@me')
    return { healthy: true, status: 'ok', checkedAt }
  } catch (error) {
    return {
      healthy: false,
      status: 'error',
      checkedAt,
      detail: error instanceof Error ? error.message : 'health check failed',
    }
  }
}
