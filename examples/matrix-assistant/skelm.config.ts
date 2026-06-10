import { defineWorkflowConfig } from '@skelm/core'
import { MatrixIntegration } from '@skelm/integrations'
import { createPiSdkBackend } from '@skelm/pi'

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

export default defineWorkflowConfig({
  registries: {
    workflows: { glob: '*.workflow.{mts,ts}' },
  },
  instances: [
    createPiSdkBackend({
      id: 'pi',
      provider: process.env.PI_PROVIDER ?? 'llamacpp',
      model: process.env.PI_MODEL ?? 'qwen36',
      maxConcurrent: 1,
    }),
  ],
  triggerSources: [
    {
      id: 'matrix',
      driver: matrix.createTriggerSource({
        dropPending: true,
        ...(allowedRoomIds.length > 0 && { allowedRoomIds }),
      }),
    },
  ],
})
