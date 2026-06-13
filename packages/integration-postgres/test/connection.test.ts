import type { CredentialReference } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'

import { POSTGRES_CREDENTIAL_SCHEMA_ID, definePostgresConnection } from '../src/connection.js'

describe('definePostgresConnection', () => {
  const ref: CredentialReference = { kind: 'credential-ref', secretName: 'PG_URL' }

  it('builds a reference-only connection', () => {
    const conn = definePostgresConnection({ id: 'main', credentials: [ref] })
    expect(conn.integrationId).toBe('postgres')
    expect(conn.credentialSchemaId).toBe(POSTGRES_CREDENTIAL_SCHEMA_ID)
    expect(conn.credentials).toEqual([ref])
  })

  it('carries non-secret metadata', () => {
    const conn = definePostgresConnection({
      id: 'main',
      credentials: [ref],
      metadata: { schema: 'app', readOnly: true },
    })
    expect(conn.metadata).toEqual({ schema: 'app', readOnly: true })
  })

  it('rejects a reference that smuggles a resolved value', () => {
    const leaky = {
      kind: 'credential-ref',
      secretName: 'PG_URL',
      password: 'hunter2',
    } as unknown as CredentialReference
    expect(() => definePostgresConnection({ id: 'main', credentials: [leaky] })).toThrow(
      /must not carry a secret value/,
    )
  })
})
