/**
 * Provider registry contracts.
 *
 * skelm splits the OpenClaw/Hermes provider zoo into a small set of typed
 * provider categories: model, tool, media, browser, memory, and secret. Each
 * provider declares identity, the credential references it needs (never
 * values), capabilities, optional cost/latency metadata, and a health check.
 * These are interfaces only — concrete provider adapters live in later
 * `@skelm/provider-*` packages.
 *
 * Reconciliation with `@skelm/agent`'s `BrowserProvider`: the agent package
 * already defines a *driver* contract (navigate/click/type/screenshot/extract)
 * that the native agent's browser tools drive under gateway-enforced network
 * egress. That is the low-level action surface. The {@link BrowserProvider}
 * here is the *registry-level* contract: it adds provider identity, capability
 * descriptor, health, and cost metadata, and exposes the agent's driver through
 * its `driver` member typed as {@link BrowserDriver}. {@link BrowserDriver} is a
 * structural mirror of the agent's interface so the agent's `BrowserProvider`
 * satisfies it without the SDK taking a dependency on the heavy `@skelm/agent`
 * package. Concrete browser packages implement both layers.
 */

import type { CredentialReference } from './credentials.js'
import type { ProviderHealthCheck } from './testing.js'

/** Optional cost/latency metadata a provider may publish for routing/UX. */
export interface ProviderCostMetadata {
  /** Currency for the cost figures (ISO 4217), when costs are published. */
  readonly currency?: string
  /** Approximate cost per 1k input units (tokens, requests, …), when known. */
  readonly perThousandInput?: number
  /** Approximate cost per 1k output units, when known. */
  readonly perThousandOutput?: number
  /** Typical latency in milliseconds, when known. */
  readonly typicalLatencyMs?: number
}

/** Fields shared by every provider category. */
export interface ProviderBase {
  /** Stable provider id (e.g. `openai`, `anthropic`, `searxng`). */
  readonly id: string
  /** Which provider category this implements. */
  readonly category: ProviderCategory
  /** Secret references this provider needs; resolved by the gateway. Never values. */
  readonly credentials: readonly CredentialReference[]
  /** Optional cost/latency metadata. */
  readonly cost?: ProviderCostMetadata
  /** Liveness/credential check. */
  health(): Promise<ProviderHealthCheck>
}

export type ProviderCategory = 'model' | 'tool' | 'media' | 'browser' | 'memory' | 'secret'

/** Model (LLM) provider: chat/completion/embedding backends. */
export interface ModelProvider extends ProviderBase {
  readonly category: 'model'
  /** Model ids this provider exposes. */
  readonly models: readonly string[]
  readonly supportsStreaming: boolean
  readonly supportsMultimodal: boolean
}

/** Tool provider: a named set of callable tools (web search, vision, …). */
export interface ToolProvider extends ProviderBase {
  readonly category: 'tool'
  /** Tool ids this provider exposes. */
  readonly tools: readonly string[]
}

/** Media provider: TTS/STT/image/video generation and analysis. */
export interface MediaProvider extends ProviderBase {
  readonly category: 'media'
  /** Operations this provider supports (e.g. `tts`, `stt`, `image.generate`). */
  readonly operations: readonly string[]
}

/**
 * Low-level browser driver. Structural mirror of `@skelm/agent`'s
 * `BrowserProvider` so an agent driver satisfies it without an SDK→agent
 * dependency. Permission enforcement (network egress, artifact sinks) stays in
 * the agent tool wrappers / gateway — the driver itself performs no enforcement.
 */
export interface BrowserDriver {
  navigate(url: string): Promise<{ text: string; url?: string }>
  click(selector: string): Promise<{ text: string; url?: string }>
  type(input: { selector: string; text: string }): Promise<{ text: string; url?: string }>
  screenshot(input?: { selector?: string }): Promise<{ data: string; contentType: string }>
  extract(input: { selector?: string }): Promise<{ text: string; url?: string }>
}

/** Browser provider: registry-level wrapper around a {@link BrowserDriver}. */
export interface BrowserProvider extends ProviderBase {
  readonly category: 'browser'
  /** Whether the provider runs headless. */
  readonly headless: boolean
  /** The action driver the agent's browser tools drive. */
  readonly driver: BrowserDriver
}

/** Memory provider: cross-session memory store backends. */
export interface MemoryProvider extends ProviderBase {
  readonly category: 'memory'
  readonly supportsVectorSearch: boolean
}

/**
 * Secret provider: a backend the gateway can resolve secret references against
 * (e.g. Bitwarden, Vault). Resolution itself is gateway-owned; this interface
 * only declares the provider's identity and health for registry/dashboard use.
 */
export interface SecretProvider extends ProviderBase {
  readonly category: 'secret'
}

/** Any provider category. */
export type AnyProvider =
  | ModelProvider
  | ToolProvider
  | MediaProvider
  | BrowserProvider
  | MemoryProvider
  | SecretProvider

/**
 * Registry of providers available to a gateway. Implemented by the gateway;
 * integration/provider packages register through it. Lookups are by id within a
 * category.
 */
export interface ProviderRegistry {
  register(provider: AnyProvider): void
  get(category: 'model', id: string): ModelProvider | undefined
  get(category: 'tool', id: string): ToolProvider | undefined
  get(category: 'media', id: string): MediaProvider | undefined
  get(category: 'browser', id: string): BrowserProvider | undefined
  get(category: 'memory', id: string): MemoryProvider | undefined
  get(category: 'secret', id: string): SecretProvider | undefined
  list(category?: ProviderCategory): readonly AnyProvider[]
}
