import { code, pipeline } from '@skelm/core'
import { z } from 'zod'
import { MEMORY_SECRET, WORKFLOW_PERMISSIONS } from '../permissions.js'
import { runWeeklyArchive } from '../workflows/weekly-archive.js'
import { assembleDeps } from './runtime.js'

export default pipeline({
  id: 'memory-weekly-archive',
  description: 'Fold aged memories into a weekly archive memory.',
  output: z.object({ workflow: z.string(), ok: z.boolean() }),
  steps: [
    code({
      id: 'weekly-archive',
      secrets: [MEMORY_SECRET],
      permissions: WORKFLOW_PERMISSIONS['weekly-archive'],
      run: async (ctx) => {
        const { deps, config } = assembleDeps(ctx, 'weekly-archive')
        return runWeeklyArchive(deps, config)
      },
    }),
  ],
})
