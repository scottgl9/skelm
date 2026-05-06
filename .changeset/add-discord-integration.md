---
'@skelm/integrations': minor
---

Add `DiscordIntegration` connector. Mirrors the Slack connector shape:
- Send messages to channels (with thread + reply support)
- React to messages with unicode emojis
- Project Discord interaction payloads (PING / slash command /
  message component) into typed pipeline trigger inputs
- Verify Ed25519 interaction signatures against the application's
  public key

Credentials resolve through the existing trust boundary; secrets
never flow through the audit log.
