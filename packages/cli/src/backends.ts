import { type SkelmAgentOptions, createSkelmAgentBackend } from '@skelm/agent'
import { type CodexBackendOptions, createCodexBackend } from '@skelm/codex'
import {
  BackendRegistry,
  type Pipeline,
  type SecretResolver,
  type SkelmConfig,
  type Step,
  createAcpBackend,
  createAnthropicBackend,
  createOpenAIBackend,
} from '@skelm/core'
import { type OpencodeBackendConfig, createOpencodeBackendFromConfig } from '@skelm/opencode'
import { createPiBackendFromConfig } from '@skelm/pi'

export function applyConfiguredBackends<TInput, TOutput>(
  pipeline: Pipeline<TInput, TOutput>,
  config: SkelmConfig,
): Pipeline<TInput, TOutput> {
  const defaultBackend = pickDefaultBackend(config)
  const defaultInferBackend = readString(config.backends?.inference) ?? defaultBackend
  const defaultAgentBackend = readString(config.backends?.agent) ?? defaultBackend

  return patchPipeline(pipeline, defaultInferBackend, defaultAgentBackend)
}

export async function buildBackendRegistry(
  config: SkelmConfig,
  pipeline?: Pipeline<unknown, unknown>,
  secretResolver?: SecretResolver,
): Promise<BackendRegistry | undefined> {
  const backendIds = configuredBackendIds(config)

  // Pre-built instances — register directly, exclude their ids from string-keyed lookup.
  const registry = new BackendRegistry({ models: config.models })
  const instanceIds = new Set((config.instances ?? []).map((b) => b.id))
  for (const instance of config.instances ?? []) {
    registry.register(instance)
    backendIds.delete(instance.id)
  }

  // Add pipeline-referenced backend ids that aren't already covered by instances.
  if (pipeline !== undefined) {
    for (const id of backendIdsReferencedByPipeline(pipeline)) {
      if (!instanceIds.has(id)) backendIds.add(id)
    }
  }

  if (backendIds.size === 0 && instanceIds.size === 0) return undefined
  if (backendIds.size === 0) return registry

  for (const backendId of backendIds) {
    const backend = await Promise.resolve(createBackend(backendId, config, secretResolver))
    registry.register(backend)
  }
  return registry
}

function backendIdsReferencedByPipeline(pipeline: Pipeline<unknown, unknown>): Set<string> {
  const ids = new Set<string>()
  for (const step of pipeline.steps as readonly Step[]) {
    const id = (step as { backend?: string }).backend
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  return ids
}

function patchPipeline<TInput, TOutput>(
  pipeline: Pipeline<TInput, TOutput>,
  defaultInferBackend: string | undefined,
  defaultAgentBackend: string | undefined,
): Pipeline<TInput, TOutput> {
  return {
    ...pipeline,
    steps: pipeline.steps.map((step) => patchStep(step, defaultInferBackend, defaultAgentBackend)),
  }
}

function patchStep(
  step: Step,
  defaultInferBackend: string | undefined,
  defaultAgentBackend: string | undefined,
): Step {
  switch (step.kind) {
    case 'infer':
      return step.backend !== undefined || defaultInferBackend === undefined
        ? step
        : { ...step, backend: defaultInferBackend }
    case 'agent':
      return step.backend !== undefined || defaultAgentBackend === undefined
        ? step
        : { ...step, backend: defaultAgentBackend }
    case 'idempotent':
      return {
        ...step,
        step: patchStep(step.step, defaultInferBackend, defaultAgentBackend),
      }
    case 'parallel':
      return {
        ...step,
        steps: step.steps.map((child) =>
          patchStep(child, defaultInferBackend, defaultAgentBackend),
        ),
      }
    case 'forEach':
      return {
        ...step,
        step: (item, index) =>
          patchStep(step.step(item, index), defaultInferBackend, defaultAgentBackend),
      }
    case 'branch': {
      const cases = Object.fromEntries(
        Object.entries(step.cases).map(([key, child]) => [
          key,
          patchStep(child, defaultInferBackend, defaultAgentBackend),
        ]),
      )
      return {
        ...step,
        cases,
        ...(step.default !== undefined && {
          default: patchStep(step.default, defaultInferBackend, defaultAgentBackend),
        }),
      }
    }
    case 'loop':
      return { ...step, step: patchStep(step.step, defaultInferBackend, defaultAgentBackend) }
    case 'pipelineStep':
      return {
        ...step,
        pipeline: patchPipeline(step.pipeline, defaultInferBackend, defaultAgentBackend),
      }
    default:
      return step
  }
}

function createBackend(backendId: string, config: SkelmConfig, secretResolver?: SecretResolver) {
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
        ...(secretResolver !== undefined && { secretResolver }),
      })
    }
    case 'copilot-acp': {
      const cwd = readString(entry.cwd)
      return createAcpBackend({
        id: backendId,
        command: readString(entry.command) ?? 'copilot',
        args: readStringArray(entry.args) ?? ['--acp'],
        ...(cwd !== undefined && { cwd }),
      })
    }
    case 'acp': {
      // Generic ACP backend: backends: { 'my-agent': { kind: 'acp', command: 'my-cli', args: ['--acp'] } }
      const cmd = readString(entry.command)
      if (!cmd) throw new Error(`ACP backend '${backendId}' requires a 'command' field in config`)
      const acpCwd = readString(entry.cwd)
      const acpArgs = readStringArray(entry.args)
      return createAcpBackend({
        id: backendId,
        command: cmd,
        ...(acpArgs !== undefined && { args: acpArgs }),
        ...(acpCwd !== undefined && { cwd: acpCwd }),
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
        ...(secretResolver !== undefined && { secretResolver }),
      })
    }
    // Declarative id is 'skelm-agent', not 'agent': the bare `agent` key in
    // `backends:` is a reserved selector (which backend agent steps default to),
    // so it never reaches string-keyed registration.
    case 'skelm-agent': {
      // @skelm/agent takes a plain apiKey (no lazy secretResolver), so resolve eagerly.
      const directApiKey = readString(entry.apiKey)
      const resolvedApiKey = directApiKey ?? resolveSecret(entry.apiKey)
      const baseUrl = readString(entry.baseUrl)
      const model = readString(entry.model)
      const timeoutMs = readNumber(entry.timeoutMs)
      const maxTokens = readNumber(entry.maxTokens)
      const vision = typeof entry.vision === 'boolean' ? entry.vision : undefined
      const opts: SkelmAgentOptions = { id: backendId }
      if (resolvedApiKey !== undefined) opts.apiKey = resolvedApiKey
      if (baseUrl !== undefined) opts.baseUrl = baseUrl
      if (model !== undefined) opts.model = model
      if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs
      if (maxTokens !== undefined) opts.maxTokens = maxTokens
      if (vision !== undefined) opts.vision = vision
      return createSkelmAgentBackend(opts)
    }
    case 'opencode': {
      const apiKey = entry.apiKey as string | { secret: string } | undefined
      const apiUrl = readString(entry.apiUrl)
      const agent = readString(entry.agent)
      const timeout = readNumber(entry.timeout)
      const maxRetries = readNumber(entry.maxRetries)
      const logLevel = readString(entry.logLevel) as OpencodeBackendConfig['logLevel']

      const cfg: OpencodeBackendConfig = {}
      if (apiKey !== undefined) cfg.apiKey = apiKey
      if (apiUrl !== undefined) cfg.apiUrl = apiUrl
      if (agent !== undefined) cfg.agent = agent
      if (timeout !== undefined) cfg.timeout = timeout
      if (maxRetries !== undefined) cfg.maxRetries = maxRetries
      if (logLevel !== undefined) cfg.logLevel = logLevel
      return createOpencodeBackendFromConfig(cfg)
    }
    case 'codex': {
      const directApiKey = readString(entry.apiKey)
      const resolvedApiKey = directApiKey ?? resolveSecret(entry.apiKey)
      const codexPathOverride = readString(entry.codexPathOverride) ?? readString(entry.command)
      const baseUrl = readString(entry.baseUrl)
      const model = readString(entry.model)
      const modelReasoningEffort = readString(
        entry.modelReasoningEffort,
      ) as CodexBackendOptions['modelReasoningEffort']
      const skipGitRepoCheck =
        typeof entry.skipGitRepoCheck === 'boolean' ? entry.skipGitRepoCheck : undefined
      const timeoutMs = readNumber(entry.timeoutMs)
      const opts: CodexBackendOptions = { id: backendId }
      if (resolvedApiKey !== undefined) opts.apiKey = resolvedApiKey
      if (codexPathOverride !== undefined) opts.codexPathOverride = codexPathOverride
      if (baseUrl !== undefined) opts.baseUrl = baseUrl
      if (model !== undefined) opts.model = model
      if (modelReasoningEffort !== undefined) opts.modelReasoningEffort = modelReasoningEffort
      if (skipGitRepoCheck !== undefined) opts.skipGitRepoCheck = skipGitRepoCheck
      if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs
      return createCodexBackend(opts)
    }
    case 'pi': {
      const cmd = readString(entry.command)
      const cwd = readString(entry.cwd)
      const provider = readString(entry.provider)
      const model = readString(entry.model)
      const timeout = readNumber(entry.timeout)
      const maxConcurrent = readNumber(entry.maxConcurrent)

      return createPiBackendFromConfig({
        ...(cmd !== undefined && { command: cmd }),
        ...(cwd !== undefined && { cwd }),
        ...(provider !== undefined && { provider }),
        ...(model !== undefined && { model }),
        ...(timeout !== undefined && { timeout }),
        ...(maxConcurrent !== undefined && { maxConcurrent }),
      })
    }
    default:
      throw new Error(`unsupported backend in CLI config: ${backendId}`)
  }
}

function configuredBackendIds(config: SkelmConfig): Set<string> {
  // Only register backends that the config actually references — either via
  // an explicit entry in `backends`, the `default` / `inference` / `agent`
  // selectors, or the top-level `backend` field. This avoids constructing
  // (and validating) backends the workflow never uses, which would
  // otherwise throw on missing credentials for unrelated providers.
  const ids = new Set<string>()
  const backends = config.backends ?? {}
  for (const [key, value] of Object.entries(backends)) {
    if (key === 'default' || key === 'infer' || key === 'agent') continue
    if (value !== undefined) ids.add(key)
  }
  const defaultBackend = pickDefaultBackend(config)
  if (defaultBackend !== undefined) ids.add(defaultBackend)
  const inferBackend = readString(config.backends?.inference)
  if (inferBackend !== undefined) ids.add(inferBackend)
  const agentBackend = readString(config.backends?.agent)
  if (agentBackend !== undefined) ids.add(agentBackend)
  return ids
}

function pickDefaultBackend(config: SkelmConfig): string | undefined {
  return readString(config.backends?.default) ?? config.backend ?? config.defaults?.backend
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
