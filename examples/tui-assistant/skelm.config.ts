import { defineConfig } from '@skelm/core'
import { createRemoteTriggerSource } from '@skelm/integrations'
import { createPiBackend } from '@skelm/pi'
import { createTerminalFrontend } from './tui-frontend.mjs'

// The TUI is a CLI-hosted chat: `skelm run examples/tui-assistant/` activates
// this project on the gateway and then hosts the terminal UI in the CLI process.
// The gateway side is the headless `createRemoteTriggerSource()` below — no
// frontend runs in the gateway. The Ink frontend is carried on the source so
// `skelm run` picks it up and renders it locally (streaming partials + reply);
// the gateway never invokes it. (The embedded, gateway-foreground variant is
// still available via `TuiIntegration.createTriggerSource({ frontend })`; see
// drive.mts.)

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
      // Headless on the gateway; the CLI host renders `frontend`. The per-message
      // sessionId comes from the CLI (defaults to TUI_SESSION_ID or 'tui'); the
      // workflow's sessionKey derives the durable conversation.
      driver: createRemoteTriggerSource({
        frontend: createTerminalFrontend({
          banner: 'skelm tui-assistant — chat with your agent (Ctrl-C to exit)',
        }),
      }),
    },
  ],
  defaults: {
    // ⚠️  SECURITY: this grants tui-assistant a FULL permission bypass. It can
    // run arbitrary exec / network / filesystem operations as the gateway user.
    // The TUI is local, so the exposure is whoever can type at this terminal.
    // Every bypassed turn is recorded as a `permission.bypassed` audit entry.
    unrestrictedGrants: ['tui-assistant'],
  },
})
