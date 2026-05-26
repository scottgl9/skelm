import { agent, pipeline } from '@skelm/core'

// A single agent step that declares ONLY networkEgress. The gateway egress
// proxy enforces it out-of-band, so a backend that cannot enforce tool
// permissions in-process (toolPermissions: 'unsupported', like Pi RPC) must
// still be allowed to run — provided the run path wired the egress proxy.
export default pipeline({
  id: 'net-egress-only',
  steps: [
    agent({
      id: 'fetch',
      backend: 'recording-subprocess',
      prompt: 'go',
      permissions: { networkEgress: 'allow' },
    }),
  ],
})
