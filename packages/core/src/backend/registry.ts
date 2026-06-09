// In-memory backend registry. The gateway uses this at runtime; tests use it
// directly for unit-level backend wiring.

import { RegistryError } from '../errors.js'
import { BackendCapabilityError, BackendNotFoundError, backendInstallHint } from './errors.js'
import type { BackendCapabilities, BackendId, SkelmBackend } from './types.js'

/**
 * Minimal in-memory registry. The gateway will eventually use this; tests
 * already do. Resolution order: explicit backend id → first backend that
 * supports the requested capability → throw.
 */
export class BackendRegistry {
  private readonly backends = new Map<BackendId, SkelmBackend>()

  register(backend: SkelmBackend): void {
    if (this.backends.has(backend.id)) {
      throw new RegistryError(`backend already registered: ${backend.id}`, 'backend', backend.id)
    }
    this.backends.set(backend.id, backend)
  }

  has(id: BackendId): boolean {
    return this.backends.has(id)
  }

  /**
   * Idempotent register: adds the backend if its id is free, otherwise leaves
   * the existing entry untouched. Used when a runtime-activated project's
   * backends are absorbed into a running gateway — an already-trusted id is
   * never silently replaced by a later config.
   */
  registerIfAbsent(backend: SkelmBackend): 'registered' | 'exists' {
    if (this.backends.has(backend.id)) return 'exists'
    this.backends.set(backend.id, backend)
    return 'registered'
  }

  /** Pick a backend by id, falling back to first one that has `prompt`. */
  resolveForLlm(opts: { backendId?: BackendId | undefined }): SkelmBackend {
    if (opts.backendId !== undefined) {
      const found = this.backends.get(opts.backendId)
      if (!found) {
        throw new BackendNotFoundError(
          `backend not registered: ${opts.backendId}${backendInstallHint(opts.backendId)}`,
        )
      }
      if (!found.capabilities.prompt || typeof found.inference !== 'function') {
        throw new BackendCapabilityError(
          `backend ${opts.backendId} does not support infer() steps. Use a backend with single-shot inference (e.g. anthropic, openai, pi), or rewrite as agent({ maxTurns: 1 }).`,
          opts.backendId,
          'prompt',
        )
      }
      return found
    }
    for (const candidate of this.backends.values()) {
      if (candidate.capabilities.prompt && typeof candidate.inference === 'function') {
        return candidate
      }
    }
    throw new BackendNotFoundError('no backend with prompt capability is registered')
  }

  /** Pick a backend for an agent() step. */
  resolveForAgent(opts: { backendId?: BackendId | undefined }): SkelmBackend {
    if (opts.backendId !== undefined) {
      const found = this.backends.get(opts.backendId)
      if (!found) {
        throw new BackendNotFoundError(
          `backend not registered: ${opts.backendId}${backendInstallHint(opts.backendId)}`,
        )
      }
      if (typeof found.run !== 'function') {
        throw new BackendCapabilityError(
          `backend ${opts.backendId} does not support agent() steps`,
          opts.backendId,
          'prompt',
        )
      }
      return found
    }
    for (const candidate of this.backends.values()) {
      if (typeof candidate.run === 'function') return candidate
    }
    throw new BackendNotFoundError('no backend with run() capability is registered')
  }

  list(): readonly SkelmBackend[] {
    return [...this.backends.values()]
  }

  async dispose(): Promise<void> {
    for (const b of this.backends.values()) {
      if (typeof b.dispose === 'function') await b.dispose()
    }
    this.backends.clear()
  }
}
