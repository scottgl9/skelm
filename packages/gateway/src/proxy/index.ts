/**
 * Network egress proxy exports.
 */

export { EgressProxy, type EgressProxyOptions } from './egress-proxy.js'
export {
  checkHostPolicy,
  extractHostnameFromConnectTarget,
  extractHostnameFromHostHeader,
  type PolicyCheckResult,
  type TokenPolicyMap,
  InMemoryTokenPolicyStore,
} from './egress-policy.js'
export { emitEgressAudit, type NetworkEgressEvent } from './egress-audit.js'
