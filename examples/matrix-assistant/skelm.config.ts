import { defineConfig } from '@skelm/core'
import { MatrixIntegration } from '@skelm/integrations'
import { createPiBackend } from '@skelm/pi'

const homeserverUrl = process.env.MATRIX_HOMESERVER_URL
const accessToken = process.env.MATRIX_ACCESS_TOKEN
if (homeserverUrl === undefined || homeserverUrl === '') {
  console.warn('[matrix-assistant example] MATRIX_HOMESERVER_URL is not set')
}
if (accessToken === undefined || accessToken === '') {
  console.warn('[matrix-assistant example] MATRIX_ACCESS_TOKEN is not set')
}

// Who-can-talk allowlist. REQUIRED in practice for this example: the agent runs
// unrestricted, so an open channel would let anyone who can join the room run
// arbitrary commands as the gateway user. Comma-separated room ids.
const allowedRoomIds = (process.env.MATRIX_ALLOWED_ROOM_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

if (allowedRoomIds.length === 0) {
  console.warn(
    '[matrix-assistant example] MATRIX_ALLOWED_ROOM_IDS is empty — the unrestricted ' +
      'agent will accept messages from ANY joined room. Set it before exposing this bot.',
  )
}

const matrix = new MatrixIntegration({
  id: 'matrix',
  name: 'Matrix',
  enabled: true,
  credentials: {
    homeserverUrl: homeserverUrl ?? '',
    accessToken: accessToken ?? '',
    // The bot's own user id, used to drop its own echoed messages. Resolved via
    // /whoami when omitted.
    ...(process.env.MATRIX_USER_ID !== undefined && { userId: process.env.MATRIX_USER_ID }),
  },
})

await matrix.init()

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
      id: 'matrix',
      driver: matrix.createTriggerSource({
        dropPending: true,
        ...(allowedRoomIds.length > 0 && { allowedRoomIds }),
      }),
    },
  ],
  defaults: {
    // ⚠️  SECURITY: this grants matrix-assistant a FULL permission bypass. It can
    // run arbitrary exec / network / filesystem operations as the gateway user.
    // Only enable for an operator you trust, on a machine you are willing to
    // expose, and always behind the allowedRoomIds allowlist above. Every
    // bypassed turn is recorded as a `permission.bypassed` audit entry.
    unrestrictedGrants: ['matrix-assistant'],
  },
})
