import type { RunStore } from './run-store.js'
import type { State, StateConfig, StateReadOptions, StateSetOptions } from './types.js'

export function createStateHandle(
  store: RunStore,
  params: { pipelineId: string; stepId?: string; config?: StateConfig },
): State {
  const namespace = resolveStateNamespace(params)
  return Object.freeze({
    get: <T>(key: string) => store.getState<T>(namespace, key),
    set: <T>(key: string, value: T, opts?: StateSetOptions) =>
      store.setState(namespace, key, value, opts),
    delete: (key: string) => store.deleteState(namespace, key),
    list: async function* (prefix?: string) {
      for await (const entry of store.listState(namespace, prefix)) {
        yield entry
      }
    },
    cas: <T>(key: string, expected: T | undefined, next: T) =>
      store.casState(namespace, key, expected, next),
    append: (stream: string, entry: unknown) => store.appendState(namespace, stream, entry),
    read: async function* (stream: string, opts?: StateReadOptions) {
      for await (const entry of store.readState(namespace, stream, opts)) {
        yield entry
      }
    },
  })
}

export function resolveStateNamespace(params: {
  pipelineId: string
  stepId?: string
  config?: StateConfig
}): string {
  const scope = params.config?.scope ?? 'pipeline'
  switch (scope) {
    case 'pipeline':
      return `pipeline:${params.pipelineId}`
    case 'step':
      return `step:${params.pipelineId}:${params.stepId ?? 'pipeline'}`
    case 'pipeline+name':
      if (params.config?.name === undefined || params.config.name.trim().length === 0) {
        throw new Error('state scope "pipeline+name" requires a non-empty name')
      }
      return `shared:${params.config.name}`
  }
}
