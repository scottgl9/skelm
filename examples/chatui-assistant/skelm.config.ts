import { defineConfig } from '@skelm/core'
import { createRemoteTriggerSource } from '@skelm/integrations'
import { createPiBackend } from '@skelm/pi'
import { createTerminalFrontend } from './chatui-frontend.mts'

// The chatui integration is a client-hosted chat: the UI lives in the client,
// the gateway side is the headless `createRemoteTriggerSource()`. Two frontends,
// one workflow:
//
//   - `tui` (transport: 'tui') — `skelm run examples/chatui-assistant/` activates
//     the project and hosts the Ink terminal UI in the CLI process. The frontend
//     is carried on the source so `skelm run` picks it up and renders it locally
//     (streaming partials + reply); the gateway never invokes it.
//   - `web` (transport: 'web') — a static browser page (`web-chat.html`) POSTs
//     each line to `/v1/chat/web/submit` and tails `/runs/:runId/stream` itself.
//     No server-side frontend. Cross-origin from a static file needs the gateway
//     started with SKELM_DEV_CORS=1 (a dev-only, default-off affordance).
//
// (The embedded, gateway-foreground variant is still available via
// `ChatUiIntegration.createTriggerSource({ frontend })`; see drive.mts.)

export default defineConfig({
  registries: {
    workflows: { glob: '*.workflow.{mts,ts}' },
  },
  instances: [
    createPiBackend({
      id: 'pi',
      ...(process.env.PI_COMMAND !== undefined && { command: process.env.PI_COMMAND }),
      provider: process.env.PI_PROVIDER ?? 'llamacpp',
      model: process.env.PI_MODEL ?? 'qwen36',
      maxConcurrent: 1,
    }),
  ],
  // Long-term recall across sessions. Requires an @skelm/agentmemory server
  // (default http://localhost:3111). Set SKELM_AGENTMEMORY=0 to disable.
  agentmemory: {
    enabled: process.env.SKELM_AGENTMEMORY !== '0',
    ...(process.env.AGENTMEMORY_URL !== undefined && { url: process.env.AGENTMEMORY_URL }),
  },
  triggerSources: [
    {
      id: 'tui',
      // Terminal transport. Headless on the gateway; the CLI host renders
      // `frontend`. The per-message sessionId comes from the CLI (defaults to
      // TUI_SESSION_ID or 'tui'); the workflow's sessionKey derives the durable
      // conversation.
      driver: createRemoteTriggerSource({
        transport: 'tui',
        frontend: createTerminalFrontend({
          banner: 'skelm chatui-assistant — chat with your agent (Ctrl-C to exit)',
        }),
      }),
    },
    {
      id: 'web',
      // Browser transport. No frontend — `web-chat.html` is the client. It POSTs
      // to /v1/chat/web/submit and renders the reply from the run stream.
      driver: createRemoteTriggerSource({ transport: 'web' }),
    },
  ],
  defaults: {
    // ⚠️  SECURITY: this grants chatui-assistant a FULL permission bypass. It can
    // run arbitrary exec / network / filesystem operations as the gateway user.
    // The terminal frontend is local; the web frontend is reachable by anyone who
    // can hit the gateway — keep it bound to localhost. Every bypassed turn is
    // recorded as a `permission.bypassed` audit entry.
    unrestrictedGrants: ['chatui-assistant'],
  },
})
