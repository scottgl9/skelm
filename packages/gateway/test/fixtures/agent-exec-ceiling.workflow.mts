import { agent, pipeline } from '@skelm/core'

// An agent step that declares allowedExecutables ['skelm','node']. The operator
// ceiling (config.defaults.permissions, allowedExecutables ['node']) must
// intersect it down to ['node'] on EVERY gateway run path — including the
// registered-pipeline HTTP run paths (routes/pipelines.ts, pipeline-runner.ts).
export default pipeline({
  id: 'agent-exec-ceiling',
  steps: [
    agent({
      id: 'probe',
      backend: 'recording-ceiling',
      prompt: 'go',
      permissions: { networkEgress: 'allow', allowedExecutables: ['skelm', 'node'] },
    }),
  ],
})
