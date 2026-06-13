/**
 * Declarative manifest for the OpenClaw host bridge.
 *
 * Describes the bridge's tool surface, the single credential it needs (the
 * gateway bearer token, BY REFERENCE only), and an audit-redaction policy that
 * keeps the resolved bearer out of any audit row. The gateway/host reads this to
 * register the bridge tools and render setup UI.
 */

import type { CredentialSchema, IntegrationPackageManifest } from '@skelm/integration-sdk'

/** The single credential the bridge requires: a gateway bearer token, by ref. */
export const gatewayBearerCredential: CredentialSchema = {
  id: 'skelm-gateway-bearer',
  description: 'Bearer token used to authenticate bridge calls to the skelm gateway.',
  fields: [
    {
      name: 'token',
      kind: 'token',
      description: 'Gateway bearer token — supplied by reference, resolved by the gateway.',
    },
  ],
}

export const openclawManifest: IntegrationPackageManifest = {
  name: '@skelm/openclaw',
  version: '0.1.0',
  description:
    'OpenClaw host bridge: run, inspect, cancel, and audit skelm workflows over the gateway HTTP API.',
  actions: [
    { id: 'skelm_run', description: 'Run a workflow synchronously.' },
    { id: 'skelm_start', description: 'Start a detached, tracked task.' },
    { id: 'skelm_status', description: 'Status of a run or detached task.' },
    { id: 'skelm_cancel', description: 'Cancel a run or detached task.' },
    { id: 'skelm_audit', description: 'Query hash-chained audit references.' },
    { id: 'skelm_workflow_search', description: 'List or find registered workflows.' },
  ],
  credentials: [gatewayBearerCredential],
  auditRedaction: {
    redactPaths: ['credentials.token', 'authorization', 'headers.authorization'],
  },
}
