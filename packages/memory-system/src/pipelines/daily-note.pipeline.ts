import { code, pipeline } from '@skelm/core'
import { z } from 'zod'
import { WORKFLOW_PERMISSIONS } from '../permissions.js'
import { runDailyNote } from '../workflows/daily-note.js'
import { MEMORY_SECRET, assembleDeps } from './runtime.js'

export default pipeline({
  id: 'memory-daily-note',
  description: 'Append a daily rollup note from recent memories.',
  output: z.object({ workflow: z.string(), ok: z.boolean() }),
  steps: [
    code({
      id: 'daily-note',
      secrets: [MEMORY_SECRET],
      permissions: WORKFLOW_PERMISSIONS['daily-note'],
      run: async (ctx) => {
        const { deps, config } = assembleDeps(ctx, 'daily-note')
        return runDailyNote(deps, config)
      },
    }),
  ],
})
