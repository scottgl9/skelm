/**
 * Integration-package manifest for the Postgres workflow integration. The
 * gateway reads this after load to register actions/triggers, validate
 * workflows, render the dashboard connection wizard, and apply audit redaction.
 */

import type {
  CredentialSchema,
  IntegrationPackageManifest,
  LiveTestDescriptor,
} from '@skelm/integration-sdk'

import { POSTGRES_CREDENTIAL_SCHEMA_ID } from './connection.js'
import { POSTGRES_AUDIT_REDACTION } from './redaction.js'

/** Credentials the integration needs — by reference/shape only, never values. */
export const POSTGRES_CREDENTIAL_SCHEMA: CredentialSchema = {
  id: POSTGRES_CREDENTIAL_SCHEMA_ID,
  description:
    'Postgres connection credentials. Supply a connectionString, or discrete host/port/database/user/password fields. Resolved by the gateway at dispatch.',
  fields: [
    { name: 'connectionString', kind: 'string', optional: true, description: 'postgres:// URL' },
    { name: 'host', kind: 'string', optional: true },
    { name: 'port', kind: 'number', optional: true },
    { name: 'database', kind: 'string', optional: true },
    { name: 'user', kind: 'string', optional: true },
    { name: 'password', kind: 'token', optional: true },
  ],
}

/** Opt-in live test, gated on `SKELM_LIVE_POSTGRES` plus a connection string. */
export const POSTGRES_LIVE_TEST: LiveTestDescriptor = {
  provider: 'postgres',
  name: 'Postgres parameterized round-trip',
  requiredEnv: ['SKELM_LIVE_POSTGRES', 'SKELM_LIVE_POSTGRES_URL'],
  description: 'Creates a temp table, round-trips parameterized values, drops it.',
}

export const postgresManifest: IntegrationPackageManifest = {
  name: '@skelm/integration-postgres',
  version: '0.4.8',
  description:
    'Postgres workflow integration: parameterized query/execute/transaction actions and a polling trigger.',
  actions: [
    {
      id: 'query',
      description: 'Run a parameterized read ({ text, params }) and return rows.',
      requiredPermissions: ['postgres:query'],
    },
    {
      id: 'execute',
      description:
        'Run a parameterized write (INSERT/UPDATE/DELETE) and return the affected row count.',
      requiredPermissions: ['postgres:execute'],
    },
    {
      id: 'transaction',
      description: 'Run a sequence of parameterized statements atomically.',
      requiredPermissions: ['postgres:execute'],
    },
  ],
  triggers: [
    {
      id: 'poll',
      kind: 'poll',
      description: 'Poll a table for rows past a monotonic cursor column.',
      events: ['changed'],
    },
  ],
  credentials: [POSTGRES_CREDENTIAL_SCHEMA],
  requiredPermissions: ['postgres:query', 'postgres:execute'],
  dashboard: {
    title: 'Postgres',
    fields: {
      connectionString: { label: 'Connection string', secret: true },
      host: { label: 'Host' },
      port: { label: 'Port' },
      database: { label: 'Database' },
      user: { label: 'User' },
      password: { label: 'Password', secret: true },
    },
  },
  liveTests: [POSTGRES_LIVE_TEST],
  auditRedaction: POSTGRES_AUDIT_REDACTION,
}
