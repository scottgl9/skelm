import { code, pipeline } from '@skelm/core'
import { z } from 'zod'
import { MEMORY_SECRET, WORKFLOW_PERMISSIONS } from '../permissions.js'
import { runStalePrune } from '../workflows/stale-prune.js'
import { assembleDeps } from './runtime.js'

export default pipeline({
  id: 'memory-stale-prune',
  description: 'Report stale memory candidates (read-only; no deletion).',
  output: z.object({ workflow: z.string(), ok: z.boolean() }),
  steps: [
    code({
      id: 'stale-prune',
      secrets: [MEMORY_SECRET],
      permissions: WORKFLOW_PERMISSIONS['stale-prune'],
      run: async (ctx) => {
        const { deps, config } = assembleDeps(ctx, 'stale-prune')
        return runStalePrune(deps, config)
      },
    }),
  ],
})
