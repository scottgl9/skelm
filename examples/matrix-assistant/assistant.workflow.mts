import { persistentWorkflow } from '@skelm/core'

/**
 * matrix-assistant: a freewheeling chat assistant you talk to over Matrix.
 * This is a PERSISTENT WORKFLOW: no preamble, just one durable, session-keyed
 * agent turn per fire — one conversation per room, surviving across messages
 * and gateway restarts.
 *
 * ⚠️  SECURITY: the terminal agent requests the UNRESTRICTED permission bypass —
 * full exec / network / filesystem access as the gateway user. That request is
 * inert until the operator grants this workflow's id in `skelm.config.ts`
 * (`defaults.unrestrictedGrants`). The config also pins an `allowedRoomIds`
 * allowlist so only trusted rooms can drive it. Read the README before running.
 */

interface MatrixMessageInput {
  roomId: string
  eventId: string
  sender: string
  body: string
}

export default persistentWorkflow<MatrixMessageInput>({
  id: 'matrix-assistant',
  description: 'Freewheeling unrestricted assistant over Matrix (operator-gated bypass).',
  triggers: [{ kind: 'queue', sourceId: 'matrix' }],
  agent: {
    backend: 'pi',
    system: [
      'You are a capable personal assistant chatting over Matrix.',
      'You have full access to the shell, network, and filesystem of the machine',
      'you run on — use it to actually accomplish what the user asks, then report',
      'back concisely. Answer in plain text. Keep replies short.',
    ].join(' '),
    // Requests the full bypass; only takes effect because skelm.config.ts grants
    // 'matrix-assistant'. The agentmemory ops are declared too so this stays a
    // good template even if the grant is removed and default-deny re-applies.
    permissions: {
      requestUnrestricted: true,
      agentmemory: {
        allowObserve: true,
        allowSearch: true,
        allowContext: true,
        allowSave: true,
        allowRecall: true,
      },
    },
    maxTurns: 12,
    // One durable conversation per Matrix room.
    sessionKey: (msg) => msg.roomId,
    prompt: (ctx) => (ctx.input as MatrixMessageInput).body,
    reply: (text) => ({ reply: text }),
  },
})
