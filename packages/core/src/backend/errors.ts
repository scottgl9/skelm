// Error classes thrown by backends and the backend registry.
// Separated from the SPI types so callers can catch these without importing
// the full backend interface surface.

import type { BackendCapabilities, BackendId } from './types.js'

/** Thrown when a backend is asked to do something it cannot. */
export class BackendCapabilityError extends Error {
  override readonly name = 'BackendCapabilityError'
  constructor(
    message: string,
    readonly backendId: BackendId,
    readonly capability: keyof BackendCapabilities,
  ) {
    super(message)
  }
}

/** Thrown when no backend is registered for a step's needs. */
export class BackendNotFoundError extends Error {
  override readonly name = 'BackendNotFoundError'
}

/** Thrown when a registered backend is unavailable or failed to initialize. */
export class BackendUnavailableError extends Error {
  override readonly name = 'BackendUnavailableError'
  constructor(
    message: string,
    readonly backendId: BackendId,
  ) {
    super(message)
  }
}

/**
 * Thrown when the upstream LLM stopped because it hit a `max_tokens` cap
 * (`finish_reason: 'length'`) and the visible assistant `text` was empty
 * (typical of reasoning-mode models whose entire output was consumed by
 * an internal monologue). Callers can distinguish this from a genuine
 * "upstream returned nothing" failure and decide whether to retry with
 * a larger cap, surface `reasoning`, or fail.
 */
export class LLMTruncatedError extends Error {
  override readonly name = 'LLMTruncatedError'
  constructor(
    message: string,
    readonly finishReason: string,
    readonly reasoning?: string,
  ) {
    super(message)
  }
}

/**
 * Thrown when a backend factory is given missing or invalid options
 * (no API key, missing model id, mutually-exclusive flags, etc).
 * Distinct from BackendUnavailableError, which signals a runtime
 * failure on an already-built backend.
 */
export class BackendConfigError extends Error {
  override readonly name = 'BackendConfigError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
  ) {
    super(message)
  }
}

/**
 * Thrown when an upstream LLM/agent provider returns an error response,
 * a malformed response, or a non-2xx status. `status` is the HTTP code
 * when known; `cause` carries the parsed upstream body when present.
 */
export class BackendUpstreamError extends Error {
  override readonly name = 'BackendUpstreamError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when a backend encounters a network/fetch error (DNS failure,
 * connection refused, timeout, TLS error, etc.). Distinguishable from
 * BackendUpstreamError (which means we got a response but it was an error)
 * and BackendConfigError (which means local configuration is wrong).
 */
export class BackendNetworkError extends Error {
  override readonly name = 'BackendNetworkError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when an upstream provider rejects the request as unauthenticated /
 * unauthorized (401/403 family). Previously redeclared per backend
 * (opencode, pi); consolidated here so callers can `catch` once.
 */
export class BackendAuthenticationError extends Error {
  override readonly name = 'BackendAuthenticationError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when an upstream provider rejects the request due to rate limiting
 * (429 / Retry-After). Consolidated from per-backend variants.
 */
export class BackendRateLimitError extends Error {
  override readonly name = 'BackendRateLimitError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when a backend operation exceeds its configured timeout, either
 * client-side (AbortSignal trip) or upstream-reported. Distinct from
 * BackendNetworkError — the connection was fine, the work was just too slow.
 */
export class BackendTimeoutError extends Error {
  override readonly name = 'BackendTimeoutError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when an agent session operation (create, prompt, mcp.add,
 * subscribe) fails. Wraps the upstream error payload as `cause`.
 */
export class BackendSessionError extends Error {
  override readonly name = 'BackendSessionError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown by an agent loop when the configured `maxTurns` budget is
 * exceeded without the agent terminating. Caller policy decides whether
 * to retry with a larger budget or fail the step.
 */
export class AgentMaxTurnsError extends Error {
  override readonly name = 'AgentMaxTurnsError'
  constructor(
    readonly maxTurns: number,
    readonly backendId?: BackendId,
  ) {
    super(`agent exceeded max turns (${maxTurns})`)
  }
}

export function backendInstallHint(backendId: BackendId): string {
  switch (backendId) {
    case 'vercel-ai':
      return ' (install @skelm/vercel-ai, e.g. npm i @skelm/vercel-ai, and register a vercel-ai backend instance)'
    default:
      return ''
  }
}
