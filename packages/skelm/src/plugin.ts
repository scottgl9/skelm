import type { Run, RunSummary, SerializedError, StepKind, StepResult } from '@skelm/core'

export type { Run, RunSummary, SerializedError, StepResult }

export interface PluginLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void
  info(message: string, fields?: Readonly<Record<string, unknown>>): void
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface HookContext {
  readonly logger: PluginLogger
  readonly runId: string
  readonly pipelineId: string
  readonly stepId?: string
}

export interface StepInfo {
  readonly id: string
  readonly kind: StepKind
}

export interface HookSet {
  beforeStep?: (ctx: HookContext, step: StepInfo) => Promise<void> | void
  afterStep?: (ctx: HookContext, step: StepInfo, result: StepResult) => Promise<void> | void
  onError?: (ctx: HookContext, step: StepInfo, error: SerializedError) => Promise<void> | void
  beforeRun?: (ctx: HookContext, run: RunSummary) => Promise<void> | void
  afterRun?: (ctx: HookContext, run: Run) => Promise<void> | void
}

export interface SecretResolver {
  resolve(name: string): Promise<string | undefined>
  list?(): Promise<readonly string[]>
}

export interface SecretDriverContext {
  readonly logger: PluginLogger
  readonly bootstrapToken?: string
  readonly bootstrapSecrets?: SecretResolver
}

export interface SecretDriver<TConfig = unknown> {
  readonly id: string
  init(config: TConfig, ctx: SecretDriverContext): Promise<SecretResolver> | SecretResolver
}

export interface PluginContributions {
  readonly providers?: {
    readonly models?: readonly unknown[]
    readonly agents?: readonly unknown[]
  }
  readonly hooks?: HookSet
  readonly secretDrivers?: readonly SecretDriver[]
  readonly skills?: readonly string[]
}

export interface SkelmPlugin {
  readonly id: string
  readonly version: string
  readonly pluginApi?: '1' | 1
  readonly contributes?: PluginContributions
}

export function definePlugin<TPlugin extends SkelmPlugin>(plugin: TPlugin): TPlugin {
  return plugin
}
