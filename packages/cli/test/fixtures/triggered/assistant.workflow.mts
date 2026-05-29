import { persistentWorkflow } from '@skelm/core'

export default persistentWorkflow<{ sessionId?: string }>({
  id: 'cli-activate-fixture',
  triggers: [{ kind: 'queue', sourceId: 'mem' }],
  agent: {
    backend: 'noop',
    sessionKey: (m) => m.sessionId ?? 'default',
  },
})
