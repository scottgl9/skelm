import {
  BackendRegistry,
  type Pipeline,
  type SkelmConfig,
  type Step,
  createAcpBackend,
  createAnthropicBackend,
  createOpenAIBackend,
} from '@skelm/core'
import { createOpencodeBackendFromConfig } from '@skelm/opencode'
import { createPiBackendFromConfig } from '@skelm/pi'

export function applyConfiguredBackends<TInput, TOutput>(
  pipeline: Pipeline<TInput, TOutput>,
  config: SkelmConfig,
): Pipeline<TInput, TOutput> {
  const defaultBackend = pickDefaultBackend(config)
  const defaultLlmBackend = readString(config.backends?.llm) ?? defaultBackend
  const defaultAgentBackend = readString(config.backends?.agent) ?? defaultBackend

  return patchPipeline(pipeline, defaultLlmBackend, defaultAgentBackend)
}

export function buildBackendRegistry(config: SkelmConfig): BackendRegistry | undefined {
  const backendIds = configuredBackendIds(config)
  if (backendIds.size === 0) return undefined

  const registry = new BackendRegistry()
  for (const backendId of backendIds) {
    registry.register(createBackend(backendId, config))
  }
  return registry
}

function patchPipeline<TInput, TOutput>(
  pipeline: Pipeline<TInput, TOutput>,
  defaultLlmBackend: string | undefined,
  defaultAgentBackend: string | undefined,
): Pipeline<TInput, TOutput> {
  return {
    ...pipeline,
    steps: pipeline.steps.map((step) => patchStep(step, defaultLlmBackend, defaultAgentBackend)),
  }
}

function patchStep(
  step: Step,
  defaultLlmBackend: string | undefined,
  defaultAgentBackend: string | undefined,
): Step {
  switch (step.kind) {
    case 'llm':
      return step.backend !== undefined || defaultLlmBackend === undefined
        ? step
        : { ...step, backend: defaultLlmBackend }
    case 'agent':
      return step.backend !== undefined || defaultAgentBackend === undefined
        ? step
        : { ...step, backend: defaultAgentBackend }
    case 'idempotent':
      return {
        ...step,
        step: patchStep(step.step, defaultLlmBackend, defaultAgentBackend),
      }
    case 'parallel':
      return {
        ...step,
        steps: step.steps.map((child) => patchStep(child, defaultLlmBackend, defaultAgentBackend)),
      }
    case 'forEach':
      return {
        ...step,
        step: (item, index) =>
          patchStep(step.step(item, index), defaultLlmBackend, defaultAgentBackend),
      }
    case 'branch': {
      const cases = Object.fromEntries(
        Object.entries(step.cases).map(([key, child]) => [
          key,
          patchStep(child, defaultLlmBackend, defaultAgentBackend),
        ]),
      )
      return {
        ...step,
        cases,
        ...(step.default !== undefined && {
          default: patchStep(step.default, defaultLlmBackend, defaultAgentBackend),
        }),
      }
    }
    case 'loop':
      return { ...step, step: patchStep(step.step, defaultLlmBackend, defaultAgentBackend) }
    case 'pipelineStep':
      return {
        ...step,
        pipeline: patchPipeline(step.pipeline, defaultLlmBackend, defaultAgentBackend),
      }
    default:
      return step
  }
}

function createBackend(backendId: string, config: SkelmConfig) {
  const entry = readBackendEntry(config, backendId)
  switch (backendId) {
    case 'openai': {
      const directApiKey = readString(entry.apiKey)
      const resolvedApiKey = directApiKey ?? resolveSecret(entry.apiKey)
      const baseUrl = readString(entry.baseUrl)
      const model = readString(entry.model)
      return createOpenAIBackend({
        ...(resolvedApiKey !== undefined && { apiKey: resolvedApiKey }),
        ...(baseUrl !== undefined && { baseUrl }),
        ...(model !== undefined && { model }),
      })
    }
    case 'copilot-acp': {
      const cwd = readString(entry.cwd)
      return createAcpBackend({
        command: readString(entry.command) ?? 'copilot',
        args: readStringArray(entry.args) ?? ['--acp'],
        ...(cwd !== undefined && { cwd }),
      })
    }
    case 'anthropic': {
      const directApiKey = readString(entry.apiKey)
      const resolvedApiKey = directApiKey ?? resolveSecret(entry.apiKey)
      const baseUrl = readString(entry.baseUrl)
      const model = readString(entry.model)
      return createAnthropicBackend({
        ...(resolvedApiKey !== undefined && { apiKey: resolvedApiKey }),
        ...(baseUrl !== undefined && { baseUrl }),
        ...(model !== undefined && { model }),
      })
    }
    case 'opencode': {
      return createOpencodeBackendFromConfig({
        apiKey: entry.apiKey as string | { secret: string } | undefined,
        apiUrl: readString(entry.apiUrl),
        agent: readString(entry.agent),
        timeout: readNumber(entry.timeout),
        maxRetries: readNumber(entry.maxRetries),
        logLevel: readString(entry.logLevel) as 'debug' | 'info' | 'warn' | 'error' | undefined,
      })
    }
    case 'pi': {
      return createPiBackendFromConfig({
        command: readString(entry.command),
        cwd: readString(entry.cwd),
        args: readStringArray(entry.args),
        timeout: readNumber(entry.timeout),
        maxRetries: readNumber(entry.maxRetries),
        logLevel: readString(entry.logLevel) as 'debug' | 'info' | 'warn' | 'error' | undefined,
      })
    }
    default:
      throw new Error(`unsupported backend in CLI config: ${backendId}`)
  }
}

function configuredBackendIds(config: SkelmConfig): Set<string> {
  const ids = new Set<string>(['openai', 'anthropic', 'copilot-acp', 'opencode', 'pi'])
  const backends = config.backends ?? {}
  for (const [key, value] of Object.entries(backends)) {
    if (key === 'default' || key === 'llm' || key === 'agent') continue
    if (value !== undefined) ids.add(key)
  }
  const defaultBackend = pickDefaultBackend(config)
  if (defaultBackend !== undefined) ids.add(defaultBackend)
  const llmBackend = readString(config.backends?.llm)
  if (llmBackend !== undefined) ids.add(llmBackend)
  const agentBackend = readString(config.backends?.agent)
  if (agentBackend !== undefined) ids.add(agentBackend)
  return ids
}

function pickDefaultBackend(config: SkelmConfig): string | undefined {
  return readString(config.backends?.default) ?? config.backend
}

function readBackendEntry(config: SkelmConfig, backendId: string): Record<string, unknown> {
  const raw = config.backends?.[backendId]
  if (raw === undefined || typeof raw === 'string' || raw === null) return {}
  return raw as Record<string, unknown>
}

function resolveSecret(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('secret' in value)) return undefined
  const key = (value as { secret?: unknown }).secret
  if (typeof key !== 'string' || !key) return undefined
  return process.env[key]
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
