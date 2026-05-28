/**
 * Standalone TUI driver — exercise the terminal UI with NO gateway and NO LLM.
 *
 * Wires the `tui` integration's trigger source to the same terminal frontend the
 * gateway uses, but with a trivial echo handler in place of an agent turn, so
 * you can test the UI loop (type a line → "thinking…" → reply → prompt again) on
 * its own:
 *
 *   node examples/tui-assistant/drive.mts
 *
 * The integration is the mechanism; `tui-frontend.mts` is the UI. Only the reply
 * is a stub here — everything you see is the real frontend.
 */
import { TuiIntegration } from '@skelm/integrations'
import { createTerminalFrontend } from './tui-frontend.mjs'

const tui = new TuiIntegration({
  id: 'tui',
  name: 'Terminal UI',
  enabled: true,
  credentials: {},
})

await tui.init()

const source = tui.createTriggerSource({
  frontend: createTerminalFrontend({
    banner: 'skelm tui-assistant — echo driver (no gateway, no model)',
  }),
})

source.start({
  onMessage: async (payload) => {
    const msg = payload as { text: string }
    // Stand-in for one enforced agent turn. The gateway would run the agent and
    // call onResult with `{ reply }`; here we echo so the UI is testable solo.
    await source.onResult?.(payload, { reply: `echo: ${msg.text}` })
  },
})
