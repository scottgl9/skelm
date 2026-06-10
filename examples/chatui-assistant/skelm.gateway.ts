import { defineGatewayConfig } from '@skelm/core'

// Operator-owned gateway config for the chatui-assistant example.
// agentmemory and unrestrictedGrants are gateway concerns — they control
// infrastructure wiring and security grants that only an operator can authorise.
export default defineGatewayConfig({
  // Long-term recall across sessions. Requires an @skelm/agentmemory server
  // (default http://localhost:3111). Set SKELM_AGENTMEMORY=0 to disable.
  agentmemory: {
    enabled: process.env.SKELM_AGENTMEMORY !== '0',
    ...(process.env.AGENTMEMORY_URL !== undefined && { url: process.env.AGENTMEMORY_URL }),
  },
  defaults: {
    // ⚠️  SECURITY: this grants chatui-assistant a FULL permission bypass. It can
    // run arbitrary exec / network / filesystem operations as the gateway user.
    // The terminal frontend is local; the web frontend is reachable by anyone who
    // can hit the gateway — keep it bound to localhost. Every bypassed turn is
    // recorded as a `permission.bypassed` audit entry.
    unrestrictedGrants: ['chatui-assistant'],
  },
})
