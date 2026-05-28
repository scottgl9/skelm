import { defineConfig } from '@skelm/core'
import { TuiIntegration } from '@skelm/integrations'
import { createPiBackend } from '@skelm/pi'
import { createTerminalFrontend } from './tui-frontend.mjs'

// The TUI is local-only and needs no credentials — it binds to the terminal the
// gateway runs in. Start the gateway in the FOREGROUND to chat with the agent.
// The integration is just the mechanism; the UI frontend lives in this example
// (tui-frontend.mts) and is wired in below.
const tui = new TuiIntegration({
  id: 'tui',
  name: 'Terminal UI',
  enabled: true,
  credentials: {},
})

await tui.init()

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
      driver: tui.createTriggerSource({
        frontend: createTerminalFrontend({
          banner: 'skelm tui-assistant — chat with your agent (Ctrl-C to exit)',
        }),
        // One durable conversation per session id; override to resume a thread.
        sessionId: process.env.TUI_SESSION_ID ?? 'tui',
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
