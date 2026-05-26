import { code, pipeline } from '@skelm/core'

// A single code step that declares a PERSISTENT workspace. The runtime
// prepares the workspace via the gateway's WorkspaceManager, so the created
// directory must land under the gateway's stateDir-scoped persistent base —
// the same base the /workspaces routes read from. The step writes the
// workspace path to its output so a test can assert where it landed.
export default pipeline({
  id: 'persistent-workspace',
  steps: [
    code({
      id: 'use-ws',
      workspace: { mode: 'persistent', name: 'main' },
      run: (ctx) => ({ workspacePath: ctx.workspace?.path }),
    }),
  ],
})
