import { code, pipeline } from '@skelm/core'
import { z } from 'zod'
import { MEMORY_SECRET, WORKFLOW_PERMISSIONS } from '../permissions.js'
import { runSearchHealth } from '../workflows/search-health.js'
import { assembleDeps } from './runtime.js'

const InputSchema = z.object({ queries: z.array(z.string().min(1)).default([]) })

export default pipeline({
  id: 'memory-search-health',
  description: 'Probe search-index health with canary queries (read-only).',
  input: InputSchema,
  output: z.object({ workflow: z.string(), ok: z.boolean() }),
  steps: [
    code({
      id: 'search-health',
      secrets: [MEMORY_SECRET],
      permissions: WORKFLOW_PERMISSIONS['search-health'],
      run: async (ctx) => {
        const { queries } = InputSchema.parse(ctx.input)
        const { deps, config } = assembleDeps(ctx, 'search-health')
        return runSearchHealth(deps, config, { queries })
      },
    }),
  ],
})
