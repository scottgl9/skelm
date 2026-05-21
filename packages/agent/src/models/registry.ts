import type { ModelEntry, RegisterProviderOptions, ResolvedModel } from './types.js'

/**
 * Tracks named providers, each with its own connection details and a list
 * of model entries. Pipelines call `find(provider, id)` per step to route
 * the request to a model — this is *per-call*, not per-process: nothing in
 * a registry instance is mutable shared state across runs.
 */
export class ModelRegistry {
  private readonly providers = new Map<string, RegisterProviderOptions>()

  registerProvider(name: string, opts: RegisterProviderOptions): void {
    this.providers.set(name, opts)
  }

  find(provider: string, modelId: string): ResolvedModel | undefined {
    const p = this.providers.get(provider)
    if (p === undefined) return undefined
    const entry = p.models.find((m) => m.id === modelId)
    if (entry === undefined) return undefined
    return {
      provider,
      entry,
      baseUrl: p.baseUrl,
      ...(p.apiKey !== undefined && { apiKey: p.apiKey }),
      ...(p.headers !== undefined && { headers: p.headers }),
    }
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name)
  }

  listProviders(): string[] {
    return [...this.providers.keys()]
  }

  /** Every (provider, model) pair currently registered. */
  list(): Array<{ provider: string; model: ModelEntry }> {
    const out: Array<{ provider: string; model: ModelEntry }> = []
    for (const [provider, p] of this.providers) {
      for (const model of p.models) out.push({ provider, model })
    }
    return out
  }
}
