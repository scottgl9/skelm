import { StateConfigError } from './errors.js'
import type { StateStore } from './run-store.js'
import type { State, StateConfig, StateReadOptions, StateSetOptions } from './types.js'

export function createStateHandle(
  store: StateStore,
  params: { pipelineId: string; stepId?: string; config?: StateConfig },
): State {
  const namespace = resolveStateNamespace(params)
  const scopedParams = Object.freeze({
    pipelineId: params.pipelineId,
    ...(params.stepId !== undefined && { stepId: params.stepId }),
  })
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
    scope: (config: StateConfig) => createStateHandle(store, { ...scopedParams, config }),
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
      if (params.stepId === undefined) {
        throw new StateConfigError('state scope "step" requires a current step id')
      }
      return `step:${params.pipelineId}:${params.stepId}`
    case 'pipeline+name':
      if (params.config?.name === undefined || params.config.name.trim().length === 0) {
        throw new StateConfigError('state scope "pipeline+name" requires a non-empty name')
      }
      return `shared:${params.config.name}`
  }
}
