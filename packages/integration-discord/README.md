# @skelm/integration-discord

A stateful Discord chat integration for [skelm](https://skelm.dev), built on the
`@skelm/integration-sdk` conversation-adapter primitives. Ships a
`ConversationAdapter` with messages, edits, threads, reactions, slash
command triggers, and buttons, typed actions and triggers, Ed25519
interaction-signature verification, and an `IntegrationPackageManifest` the
gateway reads to register the package.

## Install

```sh
pnpm add @skelm/integration-discord
```

## Credentials — by reference only

This package never reads `process.env` for secrets and never holds or persists
the bot token. The gateway owns secret resolution: it resolves the
`CredentialReference`s on a `Connection` to ephemeral values at dispatch and
supplies them to the adapter via a `tokenResolver`.

The declared credential schema (`DISCORD_CREDENTIAL_SCHEMA`):

| Field       | Kind   | Purpose                                                            |
| ----------- | ------ | ------------------------------------------------------------------ |
| `botToken`  | token  | Bot token from the Developer Portal (Bot → Token).                 |
| `publicKey` | string | Application public key (hex), used to verify interaction requests. |

A connection references the token by name — never by value:

```ts
import type { Connection } from '@skelm/integration-sdk'

const connection: Connection = {
  id: 'my-discord',
  integrationId: 'discord',
  credentialSchemaId: 'discord',
  credentials: [{ kind: 'credential-ref', secretName: 'DISCORD_BOT_TOKEN' }],
}
```

## Adapter usage

The gateway constructs the adapter with an egress policy and a token resolver it
owns, then connects it:

```ts
import { DiscordAdapter } from '@skelm/integration-discord'

const adapter = new DiscordAdapter({
  egress: (host) => ({ allow: host === 'discord.com' }),
  tokenResolver: async (conn) => gateway.resolveSecret(conn.credentials[0]),
})

await adapter.connect(connection)
const ref = await adapter.sendMessage({
  target: { conversationId: '<channel-id>' },
  text: 'hello from skelm',
})
await adapter.addReaction(ref, '👍')
```

All REST calls go through the SDK's egress-gated `httpRequest`; a denied host is
refused before any request is made.

## Capability matrix

| Capability       | Supported | Notes                                                |
| ---------------- | --------- | ---------------------------------------------------- |
| `sendMessage`    | yes       | required op                                          |
| `sendTyping`     | yes       | required op                                          |
| `getTargetInfo`  | yes       | required op                                          |
| `editMessage`    | yes       |                                                      |
| `deleteMessage`  | yes       |                                                      |
| `replyInThread`  | yes       | creates a thread from the parent message             |
| reactions        | yes       | `addReaction` / `removeReaction`                     |
| slash commands   | no        | inbound slash-command interactions still normalize via webhook triggers |
| buttons          | yes       | component interactions normalize to `callback`       |
| media            | no        | inbound attachments normalize; outbound upload unsupported |
| max message len  | 2000      |                                                      |
| escape hatches   | —         | `embeds`, `components`, `allowed_mentions` via `providerOptions` |

Provider-specific payloads (embeds, button rows) pass through
`OutboundEvent.providerOptions`.

If an outbound workflow needs media, host it somewhere Discord can already
reach and send the URL/embed through `providerOptions`; `sendMessage`
rejects `attachments` until multipart upload support exists.

## Actions

`sendMessage`, `sendEmbed`, `addReaction`, `createThread`.

## Triggers

| Trigger             | Kind         | Events                                |
| ------------------- | ------------ | ------------------------------------- |
| `messageReceived`   | event-source | `MESSAGE_CREATE`, `MESSAGE_UPDATE`    |
| `slashCommand`      | webhook      | `INTERACTION_CREATE:command`          |
| `reactionAdded`     | event-source | `MESSAGE_REACTION_ADD`                |
| `buttonInteraction` | webhook      | `INTERACTION_CREATE:component`        |

## Interaction signature verification

Discord signs every interactions-webhook request with the application's Ed25519
key. Verify it before trusting the body — unverified requests must be rejected:

```ts
import { verifyDiscordInteractionFromHeaders } from '@skelm/integration-discord'

const ok = verifyDiscordInteractionFromHeaders({
  headers: req.headers,
  rawBody, // the exact bytes received, never re-serialized
  publicKey, // the application public key (hex)
})
if (!ok) return res.status(401).end()
```

The SDK's `verifyHmacSignature` covers symmetric HMAC only, so this package adds
a Discord-specific Ed25519 verifier (`verifyDiscordInteraction`) built on
`node:crypto`. Verification never throws on malformed input — it returns `false`.

## Testing

Unit and mock tests run with no network or credentials and are the default:

```sh
pnpm exec vitest run packages/integration-discord
```

The mock fixture (`DISCORD_MOCK_FIXTURE`) ships canned gateway dispatches and
interaction payloads driven through the adapter.

### Live test (opt-in)

The live round-trip is gated and skips cleanly unless all of these are set:

| Env var                          | Purpose                          |
| -------------------------------- | -------------------------------- |
| `SKELM_LIVE_DISCORD=1`           | enables the live test            |
| `SKELM_DISCORD_BOT_TOKEN`        | bot token for the test account   |
| `SKELM_DISCORD_TEST_CHANNEL_ID`  | channel the test posts/cleans up |

It sends, edits, reacts to, and deletes a message, cleaning up after itself.

## Security

- Credentials are references only; the token is resolved by the gateway and
  never read from `process.env`, logged, returned, or persisted by this package.
- All egress is gated by the gateway-supplied `EgressPolicy`.
- Interaction requests are rejected unless their Ed25519 signature verifies.
- Audit redaction (`auditRedaction.redactPaths`) covers the authorization
  header and the credential field path.
