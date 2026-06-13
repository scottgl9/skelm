import { shouldRunLiveTest } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import { emailIntegrationManifest } from '../src/manifest.js'

describe('emailIntegrationManifest', () => {
  it('declares the send action, list action, and poll trigger', () => {
    expect(emailIntegrationManifest.actions?.map((a) => a.id)).toEqual(['email.send', 'email.list'])
    expect(emailIntegrationManifest.triggers?.[0]?.id).toBe('email.poll')
    expect(emailIntegrationManifest.triggers?.[0]?.kind).toBe('poll')
  })

  it('declares SMTP and IMAP credential schemas as references only (no values)', () => {
    const ids = emailIntegrationManifest.credentials?.map((c) => c.id)
    expect(ids).toEqual(['email-smtp', 'email-imap'])
    const serialized = JSON.stringify(emailIntegrationManifest.credentials)
    expect(serialized).not.toMatch(/"value"|"password":\s*"[^"]/)
  })

  it('requires network permission (default-deny otherwise)', () => {
    expect(emailIntegrationManifest.requiredPermissions).toContain('network')
    for (const action of emailIntegrationManifest.actions ?? []) {
      expect(action.requiredPermissions).toContain('network')
    }
  })

  it('ships an audit redaction policy covering password and bodies', () => {
    const paths = emailIntegrationManifest.auditRedaction?.redactPaths ?? []
    expect(paths).toContain('credentials.password')
    expect(paths).toContain('message.text')
  })

  it('gates the live test on SKELM_LIVE_EMAIL and skips cleanly when unset', () => {
    const live = emailIntegrationManifest.liveTests?.[0]
    expect(live).toBeDefined()
    expect(live?.requiredEnv).toContain('SKELM_LIVE_EMAIL')
    if (!live) throw new Error('missing live descriptor')
    expect(shouldRunLiveTest(live, {})).toBe(false)
    const full = Object.fromEntries(live.requiredEnv.map((k) => [k, 'x']))
    expect(shouldRunLiveTest(live, full)).toBe(true)
  })

  it('ships a deterministic mock fixture', () => {
    expect(emailIntegrationManifest.mockFixtures?.[0]?.provider).toBe('email')
    expect(emailIntegrationManifest.mockFixtures?.[0]?.payloads.imapMessage).toBeDefined()
  })
})
