import { ConfigError } from './errors.js'
import type { RunId } from './types-base.js'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Transport-neutral identity for the host application that emitted an event. */
export interface HostIdentity {
  readonly provider: string
  readonly accountId?: string
  readonly workspaceId?: string
}

/** Transport-neutral actor information for a host user, bot, or system. */
export interface HostActor {
  readonly id: string
  readonly type?: 'user' | 'bot' | 'system' | 'unknown'
  readonly handle?: string
  readonly displayName?: string
}

/** Stable reference to a host-side conversation, room, issue, PR, or channel thread. */
export interface HostThreadRef {
  readonly id: string
  readonly kind?: string
  readonly parentId?: string
}

/** Optional correlation data carried between host events, skelm runs, and replies. */
export interface HostRunCorrelation {
  readonly pipelineId?: string
  readonly runId?: RunId
  readonly correlationId?: string
}

/** Adapter input accepted by normalizeHostEvent(). */
export interface HostEventInput<TPayload = unknown> {
  readonly host: HostIdentity
  readonly type: string
  readonly payload: TPayload
  readonly eventId?: string
  readonly actor?: HostActor
  readonly thread?: HostThreadRef
  readonly occurredAt?: string | number | Date
  readonly receivedAt?: string | number | Date
  readonly dedupeKey?: string
  readonly run?: HostRunCorrelation
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Normalized inbound event shape adapters can pass to trigger payloads. */
export interface NormalizedHostEvent<TPayload = unknown> {
  readonly host: HostIdentity
  readonly type: string
  readonly payload: TPayload
  readonly eventId?: string
  readonly actor?: HostActor
  readonly thread?: HostThreadRef
  readonly occurredAt: string
  readonly receivedAt: string
  readonly dedupeKey: string
  readonly run: HostRunCorrelation
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Outbound body payload understood by host adapters. */
export interface HostActionBody {
  readonly text?: string
  readonly data?: Readonly<Record<string, unknown>>
}

/** Adapter-neutral send/reply action envelope emitted by workflows or hosts. */
export interface HostOutboundAction<TBody extends HostActionBody = HostActionBody> {
  readonly kind: 'send' | 'reply'
  readonly host: HostIdentity
  readonly target?: HostThreadRef
  readonly replyTo?: HostThreadRef
  readonly body: TBody
  readonly idempotencyKey: string
  readonly run: HostRunCorrelation
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Build a stable key for one host installation or tenant. */
export function hostIdentityKey(host: HostIdentity): string {
  assertNonEmpty(host.provider, 'host.provider')
  return hostIdentityKeyParts(host).map(encodeKeyPart).join(':')
}

/** Build a stable key for a host-side thread scoped by host identity. */
export function hostThreadKey(host: HostIdentity, thread: HostThreadRef): string {
  assertNonEmpty(thread.id, 'thread.id')
  return hostThreadKeyParts(host, thread).map(encodeKeyPart).join(':')
}

/**
 * Build the deterministic dedupe key used when an adapter did not supply one.
 * Adapters without a provider delivery id must supply occurredAt for the fallback key.
 */
export function hostEventDedupeKey(input: HostEventInput): string {
  if (input.dedupeKey !== undefined) {
    assertNonEmpty(input.dedupeKey, 'dedupeKey')
    return input.dedupeKey
  }
  assertNonEmpty(input.type, 'type')
  if (input.eventId !== undefined) {
    assertNonEmpty(input.eventId, 'eventId')
    return ['event', ...hostIdentityKeyParts(input.host), input.type, input.eventId]
      .map(encodeKeyPart)
      .join(':')
  }
  if (input.thread !== undefined) {
    return [
      'thread-event',
      ...hostThreadKeyParts(input.host, input.thread),
      input.type,
      normalizeRequiredTime(input.occurredAt, 'occurredAt'),
    ]
      .map(encodeKeyPart)
      .join(':')
  }
  return [
    'host-event',
    ...hostIdentityKeyParts(input.host),
    input.type,
    normalizeRequiredTime(input.occurredAt, 'occurredAt'),
  ]
    .map(encodeKeyPart)
    .join(':')
}

/** Normalize an adapter event without applying provider-specific policy. */
export function normalizeHostEvent<TPayload>(
  input: HostEventInput<TPayload>,
): NormalizedHostEvent<TPayload> {
  assertNonEmpty(input.host.provider, 'host.provider')
  assertNonEmpty(input.type, 'type')
  if (input.eventId !== undefined) assertNonEmpty(input.eventId, 'eventId')
  if (input.actor !== undefined) assertNonEmpty(input.actor.id, 'actor.id')
  if (input.thread !== undefined) assertNonEmpty(input.thread.id, 'thread.id')

  const receivedAt =
    normalizeOptionalTime(input.receivedAt, 'receivedAt') ?? new Date().toISOString()
  const occurredAt = normalizeOptionalTime(input.occurredAt, 'occurredAt') ?? receivedAt
  const dedupeKey = hostEventDedupeKey(input)
  const run = input.run ?? defaultRunCorrelation(input, dedupeKey)
  const normalized: Mutable<NormalizedHostEvent<TPayload>> = {
    host: input.host,
    type: input.type,
    payload: input.payload,
    occurredAt,
    receivedAt,
    dedupeKey,
    run,
  }
  if (input.eventId !== undefined) normalized.eventId = input.eventId
  if (input.actor !== undefined) normalized.actor = input.actor
  if (input.thread !== undefined) normalized.thread = input.thread
  if (input.metadata !== undefined) normalized.metadata = input.metadata
  return Object.freeze(normalized)
}

/** Create an outbound send action envelope for host adapters. */
export function createHostSendAction<TBody extends HostActionBody>(args: {
  readonly host: HostIdentity
  readonly target: HostThreadRef
  readonly body: TBody
  readonly run?: HostRunCorrelation
  readonly idempotencyKey?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}): HostOutboundAction<TBody> {
  assertNonEmpty(args.host.provider, 'host.provider')
  assertNonEmpty(args.target.id, 'target.id')
  const run = args.run ?? {}
  const action: Mutable<HostOutboundAction<TBody>> = {
    kind: 'send' as const,
    host: args.host,
    target: args.target,
    body: args.body,
    idempotencyKey:
      args.idempotencyKey ?? actionIdempotencyKey('send', args.host, args.target, run, args.body),
    run,
  }
  if (args.metadata !== undefined) action.metadata = args.metadata
  return Object.freeze(action)
}

/** Create an outbound reply action envelope for host adapters. */
export function createHostReplyAction<TBody extends HostActionBody>(args: {
  readonly event: NormalizedHostEvent
  readonly body: TBody
  readonly run?: HostRunCorrelation
  readonly idempotencyKey?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}): HostOutboundAction<TBody> {
  if (args.event.thread === undefined) {
    throw new ConfigError('createHostReplyAction(): event.thread is required', 'host-bridge')
  }
  const run = args.run ?? args.event.run
  const action: Mutable<HostOutboundAction<TBody>> = {
    kind: 'reply' as const,
    host: args.event.host,
    replyTo: args.event.thread,
    body: args.body,
    idempotencyKey:
      args.idempotencyKey ??
      actionIdempotencyKey('reply', args.event.host, args.event.thread, run, args.body),
    run,
  }
  if (args.metadata !== undefined) action.metadata = args.metadata
  return Object.freeze(action)
}

function defaultRunCorrelation(input: HostEventInput, dedupeKey: string): HostRunCorrelation {
  if (input.thread === undefined) return Object.freeze({ correlationId: dedupeKey })
  return Object.freeze({ correlationId: hostThreadKey(input.host, input.thread) })
}

function actionIdempotencyKey(
  kind: HostOutboundAction['kind'],
  host: HostIdentity,
  thread: HostThreadRef,
  run: HostRunCorrelation,
  body: HostActionBody,
): string {
  const text = body.text ?? ''
  const data = body.data === undefined ? '' : stableStringify(body.data)
  return [
    kind,
    ...hostThreadKeyParts(host, thread),
    run.runId ?? run.correlationId ?? '',
    text,
    data,
  ]
    .map(encodeKeyPart)
    .join(':')
}

function normalizeRequiredTime(value: string | number | Date | undefined, name: string): string {
  if (value === undefined) {
    throw new ConfigError(
      `${name} is required when eventId and dedupeKey are omitted`,
      'host-bridge',
    )
  }
  return normalizeTime(value, name)
}

function normalizeOptionalTime(
  value: string | number | Date | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined
  return normalizeTime(value, name)
}

function normalizeTime(value: string | number | Date, name: string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new ConfigError(`${name} must be a valid timestamp`, 'host-bridge')
  }
  return date.toISOString()
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim() === '') throw new ConfigError(`${name} must be non-empty`, 'host-bridge')
}

function hostIdentityKeyParts(host: HostIdentity): string[] {
  assertNonEmpty(host.provider, 'host.provider')
  const parts = [host.provider]
  if (host.accountId !== undefined) parts.push(`account:${host.accountId}`)
  if (host.workspaceId !== undefined) parts.push(`workspace:${host.workspaceId}`)
  return parts
}

function hostThreadKeyParts(host: HostIdentity, thread: HostThreadRef): string[] {
  assertNonEmpty(thread.id, 'thread.id')
  const parts = hostIdentityKeyParts(host)
  if (thread.kind !== undefined) parts.push(`kind:${thread.kind}`)
  if (thread.parentId !== undefined) parts.push(`parent:${thread.parentId}`)
  parts.push(`thread:${thread.id}`)
  return parts
}

function encodeKeyPart(part: string): string {
  return encodeURIComponent(part)
}

function stableStringify(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJsonValue(entryValue)]))
}
