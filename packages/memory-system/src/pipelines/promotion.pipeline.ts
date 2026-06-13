import { code, pipeline } from '@skelm/core'
import { z } from 'zod'
import { MEMORY_SECRET, WORKFLOW_PERMISSIONS } from '../permissions.js'
import { runPromotion } from '../workflows/promotion.js'
import { assembleDeps } from './runtime.js'

export default pipeline({
  id: 'memory-promotion',
  description: 'Promote high-value memories under a promoted concept.',
  output: z.object({ workflow: z.string(), ok: z.boolean() }),
  steps: [
    code({
      id: 'promotion',
      secrets: [MEMORY_SECRET],
      permissions: WORKFLOW_PERMISSIONS.promotion,
      run: async (ctx) => {
        const { deps, config } = assembleDeps(ctx, 'promotion')
        return runPromotion(deps, config)
      },
    }),
  ],
})
