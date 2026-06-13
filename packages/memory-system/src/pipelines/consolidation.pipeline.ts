import { code, pipeline } from '@skelm/core'
import { z } from 'zod'
import { MEMORY_SECRET, WORKFLOW_PERMISSIONS } from '../permissions.js'
import { runConsolidation } from '../workflows/consolidation.js'
import { assembleDeps } from './runtime.js'

const InputSchema = z.object({ queries: z.array(z.string().min(1)).default([]) })

export default pipeline({
  id: 'memory-consolidation',
  description: 'Fold near-duplicate memories into consolidated memories.',
  input: InputSchema,
  output: z.object({ workflow: z.string(), ok: z.boolean() }),
  steps: [
    code({
      id: 'consolidation',
      secrets: [MEMORY_SECRET],
      permissions: WORKFLOW_PERMISSIONS.consolidation,
      run: async (ctx) => {
        const { queries } = InputSchema.parse(ctx.input)
        const { deps, config } = assembleDeps(ctx, 'consolidation')
        return runConsolidation(deps, config, { queries })
      },
    }),
  ],
})
