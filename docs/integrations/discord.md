---
title: Discord Integration
---

# Discord Integration

`@skelm/integration-discord` is a stateful Discord chat integration built on the
[integration primitives](/reference/integration-primitives). It implements the
SDK's `ConversationAdapter` for messages, edits, threads, reactions, slash-command
triggers, and buttons, and ships typed actions/triggers, an Ed25519 interaction verifier, and an
`IntegrationPackageManifest`.

## Setup

```sh
pnpm add @skelm/integration-discord
```

Create a Discord application and bot in the
[Developer Portal](https://discord.com/developers/applications), then record the
**bot token** and the application **public key** (for interaction verification).

## Credentials — by reference only

Credentials are references, never values. The package never reads `process.env`
for secrets and never holds the token; the gateway resolves the reference at
dispatch and supplies it to the adapter through a `tokenResolver`.

| Field       | Kind   | Purpose                                                  |
| ----------- | ------ | -------------------------------------------------------- |
| `botToken`  | token  | Bot token (Developer Portal → Bot → Token).              |
| `publicKey` | string | Application public key (hex), for interaction signatures.|

```ts
import type { Connection } from '@skelm/integration-sdk'

const connection: Connection = {
  id: 'my-discord',
  integrationId: 'discord',
  credentialSchemaId: 'discord',
  credentials: [{ kind: 'credential-ref', secretName: 'DISCORD_BOT_TOKEN' }],
}
```

## Capability matrix

| Capability      | Supported | Notes                                          |
| --------------- | --------- | ---------------------------------------------- |
| sendMessage     | yes       | required op                                    |
| sendTyping      | yes       | required op                                    |
| getTargetInfo   | yes       | required op                                    |
| editMessage     | yes       |                                                |
| deleteMessage   | yes       |                                                |
| replyInThread   | yes       | creates a thread from the parent message       |
| reactions       | yes       | add / remove                                   |
| slash commands  | no        | inbound slash-command interactions still normalize via webhook triggers |
| buttons         | yes       | component interactions → `callback` events     |
| media           | no        | inbound attachments normalize; outbound upload unsupported |
| max length      | 2000      |                                                |

Embeds and component rows pass through `OutboundEvent.providerOptions`.

If a workflow needs outbound media, host it somewhere Discord can already reach
and pass the URL/embed through `providerOptions`; `sendMessage` currently
rejects `attachments`.

## Actions and triggers

Actions: `sendMessage`, `sendEmbed`, `addReaction`, `createThread`.

| Trigger             | Kind         | Events                             |
| ------------------- | ------------ | ---------------------------------- |
| `messageReceived`   | event-source | `MESSAGE_CREATE`, `MESSAGE_UPDATE` |
| `slashCommand`      | webhook      | `INTERACTION_CREATE:command`       |
| `reactionAdded`     | event-source | `MESSAGE_REACTION_ADD`             |
| `buttonInteraction` | webhook      | `INTERACTION_CREATE:component`     |

## Interaction signature verification

Discord signs interaction webhooks with the application's Ed25519 key. The
package verifies the detached signature over `timestamp + rawBody` against the
public key and **rejects unverified requests**. The SDK's HMAC helper does not
cover Ed25519, so this is a Discord-specific verifier built on `node:crypto`.

```ts
import { verifyDiscordInteractionFromHeaders } from '@skelm/integration-discord'

if (!verifyDiscordInteractionFromHeaders({ headers, rawBody, publicKey })) {
  return reject(401)
}
```

## Testing

Unit and mock tests need no network or credentials and run by default. The mock
fixture ships canned gateway dispatches and interaction payloads driven through
the adapter.

The live round-trip is opt-in and skips cleanly unless all of these are set:

| Env var                         | Purpose                          |
| ------------------------------- | -------------------------------- |
| `SKELM_LIVE_DISCORD=1`          | enables the live test            |
| `SKELM_DISCORD_BOT_TOKEN`       | bot token for the test account   |
| `SKELM_DISCORD_TEST_CHANNEL_ID` | channel the test posts/cleans up |

## Security

- Credentials are references only; the token is gateway-resolved and never read
  from `process.env`, logged, returned, or persisted.
- All REST egress runs through the gateway-supplied `EgressPolicy`.
- Unverified interaction requests are rejected.
- Audit redaction covers the authorization header and credential field path.
