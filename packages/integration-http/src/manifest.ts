/**
 * IntegrationPackageManifest for @skelm/integration-http.
 *
 * Declares the four actions, credential schema, egress permission requirement,
 * and audit redaction policy. The gateway reads this at load time to register
 * the package's surface.
 */

import type { IntegrationPackageManifest } from '@skelm/integration-sdk'
import { getActionDef, paginateActionDef, postActionDef, requestActionDef } from './actions.js'

export const manifest: IntegrationPackageManifest = {
  name: '@skelm/integration-http',
  version: '0.1.0',
  description:
    'Generic authenticated HTTP request integration — egress-gated, credential-ref aware, with retry, rate-limit, and pagination.',
  actions: [requestActionDef, getActionDef, postActionDef, paginateActionDef],
  credentials: [
    {
      id: 'http-bearer',
      description: 'Bearer token sent as Authorization: Bearer <token>.',
      fields: [
        {
          name: 'token',
          kind: 'token',
          description: 'Bearer token value; resolved by the gateway at dispatch.',
        },
      ],
    },
    {
      id: 'http-api-key',
      description: 'API key sent as a configurable header (default: X-Api-Key).',
      fields: [
        {
          name: 'apiKey',
          kind: 'token',
          description: 'API key value; resolved by the gateway at dispatch.',
        },
      ],
    },
  ],
  requiredPermissions: ['egress'],
  auditRedaction: {
    redactPaths: ['headers.authorization', 'headers.x-api-key', 'headers.x-auth-token'],
  },
}
