import { createHmac } from 'node:crypto'
import { type CredentialReference, IdempotencyTracker } from '@skelm/integration-sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  GENERIC_WEBHOOK_FIXTURE,
  type HmacWebhookVerification,
  type RawWebhookRequest,
  type WebhookTriggerConfig,
  buildWebhookManifest,
  defineWebhookTrigger,
  normalizeWebhookRequest,
  verificationCredentialRefs,
  verifyWebhookRequest,
} from '../src/index.js'

const SECRET = 'top-secret-signing-key'
const SECRET_REF: CredentialReference = {
  kind: 'credential-ref',
  secretName: 'WEBHOOK_SIGNING_SECRET',
}

function headerOf(map: Record<string, string>): (n: string) => string | undefined {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]))
  return (name: string) => lower.get(name.toLowerCase())
}

function sign(body: string, secret = SECRET, prefix = 'sha256='): string {
  return `${prefix}${createHmac('sha256', secret).update(body).digest('hex')}`
}

const hmacVerification: HmacWebhookVerification = {
  strategy: 'hmac',
  signatureHeader: 'x-webhook-signature',
  secretRef: SECRET_REF,
  prefix: 'sha256=',
}

describe('verifyWebhookRequest — HMAC', () => {
  const body = '{"event":{"type":"event.created","id":"evt_001"}}'

  it('accepts a valid signature (constant-time match)', () => {
    const result = verifyWebhookRequest({
      verification: hmacVerification,
      rawBody: body,
      header: headerOf({ 'x-webhook-signature': sign(body) }),
      resolvedSecret: SECRET,
    })
    expect(result).toEqual({ ok: true, strategy: 'hmac' })
  })

  it('rejects a tampered signature', () => {
    const result = verifyWebhookRequest({
      verification: hmacVerification,
      rawBody: body,
      header: headerOf({ 'x-webhook-signature': sign(`${body} tampered`) }),
      resolvedSecret: SECRET,
    })
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' })
  })

  it('rejects a signature made with the wrong secret', () => {
    const result = verifyWebhookRequest({
      verification: hmacVerification,
      rawBody: body,
      header: headerOf({ 'x-webhook-signature': sign(body, 'wrong-secret') }),
      resolvedSecret: SECRET,
    })
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' })
  })

  it('rejects when the signature header is absent (required)', () => {
    const result = verifyWebhookRequest({
      verification: hmacVerification,
      rawBody: body,
      header: headerOf({}),
      resolvedSecret: SECRET,
    })
    expect(result).toEqual({ ok: false, reason: 'missing-signature' })
  })

  it('rejects when the signature header is empty', () => {
    const result = verifyWebhookRequest({
      verification: hmacVerification,
      rawBody: body,
      header: headerOf({ 'x-webhook-signature': '' }),
      resolvedSecret: SECRET,
    })
    expect(result).toEqual({ ok: false, reason: 'missing-signature' })
  })

  it('rejects when no secret was resolved (default-deny, no throw)', () => {
    const result = verifyWebhookRequest({
      verification: hmacVerification,
      rawBody: body,
      header: headerOf({ 'x-webhook-signature': sign(body) }),
      // resolvedSecret omitted — gateway resolved nothing
    })
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' })
  })

  it('supports base64 encoding and a custom algorithm', () => {
    const verification: HmacWebhookVerification = {
      strategy: 'hmac',
      signatureHeader: 'x-sig',
      secretRef: SECRET_REF,
      algorithm: 'sha512',
      encoding: 'base64',
    }
    const sig = createHmac('sha512', SECRET).update(body).digest('base64')
    const result = verifyWebhookRequest({
      verification,
      rawBody: body,
      header: headerOf({ 'x-sig': sig }),
      resolvedSecret: SECRET,
    })
    expect(result).toEqual({ ok: true, strategy: 'hmac' })
  })
})

describe('verifyWebhookRequest — no-verification (explicit insecure opt-in)', () => {
  it('accepts unconditionally only when explicitly acknowledged', () => {
    const result = verifyWebhookRequest({
      verification: { strategy: 'no-verification', acknowledgeInsecure: true },
      rawBody: 'anything',
      header: headerOf({}),
    })
    expect(result).toEqual({ ok: true, strategy: 'no-verification' })
  })
})

describe('signing secret handling — reference only', () => {
  it('declares the signing secret by reference, never a value', () => {
    expect(verificationCredentialRefs(hmacVerification)).toEqual([SECRET_REF])
    // The reference carries only a name.
    expect(SECRET_REF).not.toHaveProperty('value')
    expect(SECRET_REF.secretName).toBe('WEBHOOK_SIGNING_SECRET')
  })

  it('no-verification declares no credential refs', () => {
    expect(
      verificationCredentialRefs({ strategy: 'no-verification', acknowledgeInsecure: true }),
    ).toEqual([])
  })

  it('never logs or leaks the resolved secret', () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.join(' '))
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      logs.push(a.join(' '))
    })
    const body = '{"a":1}'
    verifyWebhookRequest({
      verification: hmacVerification,
      rawBody: body,
      header: headerOf({ 'x-webhook-signature': sign(body) }),
      resolvedSecret: SECRET,
    })
    spy.mockRestore()
    errSpy.mockRestore()
    expect(logs.join('\n')).not.toContain(SECRET)
  })
})

const triggerConfig: WebhookTriggerConfig = {
  id: 'generic-webhook',
  source: 'webhook',
  path: '/webhooks/generic',
  verification: hmacVerification,
  defaultEventType: 'webhook',
  events: ['event.created', 'event.updated'],
  normalization: {
    type: { bodyPath: 'event.type' },
    id: { bodyPath: 'event.id' },
    metadataHeaders: { deliveryId: 'x-delivery-id' },
  },
}

describe('event normalization', () => {
  it('maps body fields into the EventEnvelope', () => {
    const request: RawWebhookRequest = {
      header: headerOf({ 'x-delivery-id': 'del_99' }),
      body: { event: { type: 'event.created', id: 'evt_001' } },
      receivedAt: 1_700_000_000_000,
    }
    const env = normalizeWebhookRequest(triggerConfig, request)
    expect(env).toMatchObject({
      source: 'webhook',
      type: 'event.created',
      id: 'evt_001',
      receivedAt: 1_700_000_000_000,
      metadata: { deliveryId: 'del_99' },
    })
    expect(env.payload).toEqual({ event: { type: 'event.created', id: 'evt_001' } })
  })

  it('prefers a header mapping over a body mapping', () => {
    const config: WebhookTriggerConfig = {
      ...triggerConfig,
      normalization: { type: { header: 'x-event-type', bodyPath: 'event.type' } },
    }
    const env = normalizeWebhookRequest(config, {
      header: headerOf({ 'x-event-type': 'header.win' }),
      body: { event: { type: 'body.lose' } },
    })
    expect(env.type).toBe('header.win')
  })

  it('falls back to defaultEventType when no mapping resolves', () => {
    const env = normalizeWebhookRequest(
      { ...triggerConfig, normalization: { type: { bodyPath: 'missing.path' } } },
      { header: headerOf({}), body: { event: {} } },
    )
    expect(env.type).toBe('webhook')
  })

  it('derives a stable id when the provider supplies none', () => {
    const config: WebhookTriggerConfig = {
      ...triggerConfig,
      normalization: { type: { bodyPath: 'event.type' } },
    }
    const body = { event: { type: 'event.unidentified' }, data: { note: 'x' } }
    const a = normalizeWebhookRequest(config, { header: headerOf({}), body })
    const b = normalizeWebhookRequest(config, { header: headerOf({}), body })
    expect(a.id).toBe(b.id)
    expect(a.id.length).toBeGreaterThan(0)
  })

  it('normalizes every canned fixture payload', () => {
    const config: WebhookTriggerConfig = {
      ...triggerConfig,
      normalization: { type: { bodyPath: 'event.type' }, id: { bodyPath: 'event.id' } },
    }
    for (const payload of Object.values(GENERIC_WEBHOOK_FIXTURE.payloads)) {
      const env = normalizeWebhookRequest(config, { header: headerOf({}), body: payload })
      expect(typeof env.type).toBe('string')
      expect(env.id.length).toBeGreaterThan(0)
      expect(env.source).toBe('webhook')
    }
  })
})

describe('dedup via IdempotencyTracker on the normalized envelope id', () => {
  it('suppresses a duplicate delivery of the same event id', () => {
    const trigger = defineWebhookTrigger(triggerConfig)
    const tracker = new IdempotencyTracker()
    const body = { event: { type: 'event.created', id: 'evt_dup' } }
    const first = trigger.normalize({ header: headerOf({}), body })
    const second = trigger.normalize({ header: headerOf({}), body })
    expect(first.id).toBe(second.id)
    expect(tracker.seen(first.id, 1000)).toBe(false)
    expect(tracker.seen(second.id, 1001)).toBe(true)
  })
})

describe('defineWebhookTrigger', () => {
  it('produces a TriggerDefinition and endpoint descriptor', () => {
    const trigger = defineWebhookTrigger(triggerConfig)
    expect(trigger.definition).toMatchObject({ id: 'generic-webhook', kind: 'webhook' })
    expect(trigger.endpoint).toMatchObject({ path: '/webhooks/generic', verification: 'hmac' })
    const env = trigger.normalize({
      header: headerOf({}),
      body: { event: { type: 'event.created', id: 'evt_001' } },
    })
    expect(env.type).toBe('event.created')
  })

  it('reports verification none for the insecure strategy', () => {
    const trigger = defineWebhookTrigger({
      ...triggerConfig,
      verification: { strategy: 'no-verification', acknowledgeInsecure: true },
    })
    expect(trigger.endpoint.verification).toBe('none')
  })
})

describe('buildWebhookManifest', () => {
  it('declares the signing-secret credential by reference and redacts the signature header', () => {
    const trigger = defineWebhookTrigger(triggerConfig)
    const manifest = buildWebhookManifest({
      trigger,
      mockFixtures: [GENERIC_WEBHOOK_FIXTURE],
      dashboard: { title: 'Generic Webhook' },
    })
    expect(manifest.name).toBe('@skelm/integration-webhook')
    expect(manifest.triggers).toEqual([trigger.definition])
    expect(manifest.webhooks).toEqual([trigger.endpoint])
    expect(manifest.credentials?.[0]?.fields[0]?.name).toBe('WEBHOOK_SIGNING_SECRET')
    expect(manifest.auditRedaction?.redactPaths).toContain('headers.x-webhook-signature')
    expect(manifest.supportedEvents).toEqual(['event.created', 'event.updated'])
    // No secret value anywhere in the serialized manifest.
    expect(JSON.stringify(manifest)).not.toContain(SECRET)
  })

  it('omits credentials for the no-verification strategy', () => {
    const trigger = defineWebhookTrigger({
      ...triggerConfig,
      verification: { strategy: 'no-verification', acknowledgeInsecure: true },
    })
    const manifest = buildWebhookManifest({ trigger })
    expect(manifest.credentials).toBeUndefined()
    expect(manifest.auditRedaction?.redactPaths).toEqual([])
  })
})
