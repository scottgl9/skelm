/**
 * @skelm/integration-discord
 *
 * Stateful Discord chat integration built on the @skelm/integration-sdk
 * conversation-adapter primitives. Ships a {@link DiscordAdapter}
 * (ConversationAdapter), typed actions/triggers, Ed25519 interaction-signature
 * verification, and an {@link IntegrationPackageManifest}.
 *
 * SECURITY: credentials are references only. The gateway resolves the bot-token
 * reference at dispatch and supplies the value via the adapter's
 * `tokenResolver`; this package never reads `process.env` for secrets and never
 * persists or logs the token. All REST egress runs through the SDK's
 * egress-gated `httpRequest`.
 */

export { DiscordAdapter, DISCORD_CAPABILITIES } from './adapter.js'
export type { DiscordAdapterOptions, DiscordTokenResolver } from './adapter.js'

export {
  verifyDiscordInteraction,
  verifyDiscordInteractionFromHeaders,
  DISCORD_SIGNATURE_HEADER,
  DISCORD_TIMESTAMP_HEADER,
} from './signature.js'
export type { VerifyDiscordInteractionOptions } from './signature.js'

export {
  normalizeGatewayDispatch,
  normalizeInteraction,
  parseSlashCommand,
} from './events.js'
export type { ParsedSlashCommand } from './events.js'

export { DiscordRestClient, isRetryableDiscordError } from './rest.js'
export type { DiscordRestClientOptions } from './rest.js'

export { DiscordApiError, DiscordNotConnectedError } from './errors.js'

export {
  discordManifest,
  discordHealthCheck,
  DISCORD_CREDENTIAL_SCHEMA,
  DISCORD_ACTIONS,
  DISCORD_TRIGGERS,
  DISCORD_MOCK_FIXTURE,
  DISCORD_LIVE_TEST,
} from './manifest.js'

export {
  DISCORD_PROVIDER,
  DISCORD_API_BASE,
  DISCORD_API_HOST,
} from './types.js'
export type {
  DiscordAttachment,
  DiscordGatewayDispatch,
  DiscordInteraction,
  DiscordMessage,
  DiscordChannel,
} from './types.js'
