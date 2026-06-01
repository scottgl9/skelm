/**
 * Standalone chat-UI driver — exercise the terminal UI with NO gateway and NO LLM.
 *
 * Wires the `chatui` integration's embedded trigger source to the same terminal
 * frontend the gateway uses, but with a trivial echo handler in place of an agent
 * turn, so you can test the UI loop (type a line → "thinking…" → reply → prompt
 * again) on its own:
 *
 *   node examples/chatui-assistant/drive.mts
 *
 * The integration is the mechanism; `chatui-frontend.mts` is the UI. Only the
 * reply is a stub here — everything you see is the real frontend.
 */
import { ChatUiIntegration } from '@skelm/integrations'
import { createTerminalFrontend } from './chatui-frontend.mts'

const chatui = new ChatUiIntegration({
  id: 'chatui',
  name: 'Chat UI',
  enabled: true,
  credentials: {},
})

await chatui.init()

const source = chatui.createTriggerSource({
  frontend: createTerminalFrontend({
    banner: 'skelm chatui-assistant — echo driver (no gateway, no model)',
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
