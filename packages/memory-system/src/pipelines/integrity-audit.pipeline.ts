import { code, pipeline } from '@skelm/core'
import { z } from 'zod'
import { MEMORY_SECRET, WORKFLOW_PERMISSIONS } from '../permissions.js'
import { runIntegrityAudit } from '../workflows/integrity-audit.js'
import { assembleDeps } from './runtime.js'

const InputSchema = z.object({ conceptQueries: z.array(z.string().min(1)).default([]) })

export default pipeline({
  id: 'memory-integrity-audit',
  description: 'Audit memory + graph referential integrity (read-only).',
  input: InputSchema,
  output: z.object({ workflow: z.string(), ok: z.boolean() }),
  steps: [
    code({
      id: 'integrity-audit',
      secrets: [MEMORY_SECRET],
      permissions: WORKFLOW_PERMISSIONS['integrity-audit'],
      run: async (ctx) => {
        const { conceptQueries } = InputSchema.parse(ctx.input)
        const { deps, config } = assembleDeps(ctx, 'integrity-audit')
        return runIntegrityAudit(deps, config, { conceptQueries })
      },
    }),
  ],
})
