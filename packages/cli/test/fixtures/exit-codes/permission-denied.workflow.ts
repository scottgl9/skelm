import { code, pipeline } from '@skelm/core'
import type { ExecFn } from '@skelm/core'

// Fixture for EXIT.PERMISSION_DENIED — calling ctx.exec without
// allowlisting the binary triggers the canExec default-deny path.
export default pipeline({
  id: 'fixture-permission-denied',
  steps: [
    code({
      id: 'forbidden-exec',
      // No `permissions` field — default-deny.
      run: async (ctx) => {
        return await (ctx.exec as ExecFn)({ command: 'node', args: ['-e', '0'] })
      },
    }),
  ],
})
