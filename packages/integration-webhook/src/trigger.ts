/**
 * Generic inbound webhook trigger: a typed {@link TriggerDefinition} plus an
 * endpoint descriptor, a verification strategy, and a normalizer that turns the
 * raw HTTP request into the SDK {@link EventEnvelope}.
 *
 * This package does NOT run an HTTP server. The gateway owns the inbound
 * webhook HTTP surface (`packages/gateway`); this package supplies the typed
 * descriptor + verification + normalization the gateway composes with that
 * surface.
 */

import {
  type EventEnvelope,
  type TriggerDefinition,
  type WebhookEndpointDescriptor,
  type WebhookInput,
  normalizeWebhook,
} from '@skelm/integration-sdk'
import type { WebhookVerification } from './verification.js'

/**
 * Maps fields out of the raw request into the normalized envelope. A header
 * mapping reads a request header; a body mapping reads a dotted path from the
 * parsed JSON body. Both are optional — when neither resolves, the normalizer
 * falls back (a missing id is derived from the payload by `normalizeWebhook`).
 */
export interface WebhookFieldMapping {
  /** Header name to read the value from (case-insensitive at lookup time). */
  readonly header?: string
  /** Dotted path into the parsed JSON body (e.g. `event.type`). */
  readonly bodyPath?: string
}

/** Configurable header/body field mapping for envelope normalization. */
export interface WebhookNormalizationConfig {
  /** Where the provider event `type` comes from. */
  readonly type?: WebhookFieldMapping
  /** Where the stable provider event `id` comes from (for dedupe). */
  readonly id?: WebhookFieldMapping
  /**
   * Non-secret metadata to copy from request headers. Maps an envelope
   * metadata key to a request header name.
   */
  readonly metadataHeaders?: Readonly<Record<string, string>>
}

/** Static, JSON-free configuration of a generic webhook trigger. */
export interface WebhookTriggerConfig {
  /** Trigger id (unique within the package). */
  readonly id: string
  /** Source integration/provider id stamped onto every envelope. */
  readonly source: string
  /** Gateway-relative endpoint path (e.g. `/webhooks/generic`). */
  readonly path: string
  readonly verification: WebhookVerification
  /** Default event type when no mapping resolves one. */
  readonly defaultEventType?: string
  readonly normalization?: WebhookNormalizationConfig
  readonly description?: string
  /** Provider event types this trigger can emit. */
  readonly events?: readonly string[]
}

/** The raw request the gateway hands to {@link normalizeWebhookRequest}. */
export interface RawWebhookRequest {
  readonly header: (name: string) => string | null | undefined
  /** Parsed JSON body, or the raw value if the provider sends non-JSON. */
  readonly body: unknown
  /** Epoch ms the request was received; defaults to now in the normalizer. */
  readonly receivedAt?: number
}

/** A fully-described generic webhook trigger. */
export interface WebhookTrigger {
  readonly config: WebhookTriggerConfig
  readonly definition: TriggerDefinition
  readonly endpoint: WebhookEndpointDescriptor
  /** Normalize a verified raw request into an {@link EventEnvelope}. */
  normalize<TPayload = unknown>(request: RawWebhookRequest): EventEnvelope<TPayload>
}

/**
 * Build a generic webhook trigger from static config. The returned object
 * exposes the SDK {@link TriggerDefinition}, the {@link WebhookEndpointDescriptor}
 * the gateway registers, and a `normalize` that maps the raw request into an
 * {@link EventEnvelope}. Signature verification is the gateway's job (using this
 * package's {@link verifyWebhookRequest}); `normalize` assumes a verified body.
 */
export function defineWebhookTrigger(config: WebhookTriggerConfig): WebhookTrigger {
  const definition: TriggerDefinition = {
    id: config.id,
    kind: 'webhook',
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.events !== undefined ? { events: config.events } : {}),
  }
  const endpoint: WebhookEndpointDescriptor = {
    path: config.path,
    verification: config.verification.strategy === 'hmac' ? 'hmac' : 'none',
    ...(config.events !== undefined ? { events: config.events } : {}),
  }
  return {
    config,
    definition,
    endpoint,
    normalize<TPayload = unknown>(request: RawWebhookRequest): EventEnvelope<TPayload> {
      return normalizeWebhookRequest<TPayload>(config, request)
    },
  }
}

/**
 * Map a raw webhook request into an {@link EventEnvelope} using the trigger's
 * normalization config. Header mappings win over body mappings for a field.
 * Verification must have already passed.
 */
export function normalizeWebhookRequest<TPayload = unknown>(
  config: WebhookTriggerConfig,
  request: RawWebhookRequest,
): EventEnvelope<TPayload> {
  const norm = config.normalization
  const type = resolveField(norm?.type, request) ?? config.defaultEventType ?? 'webhook'
  const id = resolveField(norm?.id, request)
  const metadata = resolveMetadata(norm?.metadataHeaders, request)

  const input: WebhookInput = {
    source: config.source,
    type,
    payload: request.body,
    ...(id !== undefined ? { id } : {}),
    ...(request.receivedAt !== undefined ? { receivedAt: request.receivedAt } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  }
  return normalizeWebhook<TPayload>(input)
}

function resolveField(
  mapping: WebhookFieldMapping | undefined,
  request: RawWebhookRequest,
): string | undefined {
  if (mapping === undefined) return undefined
  if (mapping.header !== undefined) {
    const v = request.header(mapping.header)
    if (typeof v === 'string' && v.length > 0) return v
  }
  if (mapping.bodyPath !== undefined) {
    const v = readBodyPath(request.body, mapping.bodyPath)
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  }
  return undefined
}

function resolveMetadata(
  metadataHeaders: Readonly<Record<string, string>> | undefined,
  request: RawWebhookRequest,
): Record<string, string> | undefined {
  if (metadataHeaders === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, headerName] of Object.entries(metadataHeaders)) {
    const v = request.header(headerName)
    if (typeof v === 'string' && v.length > 0) out[key] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readBodyPath(body: unknown, path: string): unknown {
  let cursor: unknown = body
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}
