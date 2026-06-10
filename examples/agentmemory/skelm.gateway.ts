import { defineGatewayConfig } from '@skelm/core'

// Gateway-owned agentmemory integration config. The workflow project config
// (skelm.config.ts) grants per-step permissions; this file tells the gateway
// which server to connect to.
//
// `secretName` is optional: set it (to a name your gateway's SecretResolver
// knows) only when your agentmemory server requires a bearer token.
export default defineGatewayConfig({
  agentmemory: {
    enabled: true,
    url: 'http://localhost:3111',
    // secretName: 'AGENTMEMORY_SECRET',
    timeoutMs: 3000,
  },
})
