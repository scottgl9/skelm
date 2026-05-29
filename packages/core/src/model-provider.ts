/**
 * Model Provider abstraction for LLM endpoints
 *
 * Supports: OpenAI, Anthropic, vllm, sglang, ollama, etc.
 * Used for direct LLM() calls in workflows
 */

import type { Context, LlmStep } from './types.js'
import type { RunMetadata } from './types.js'

/**
 * Model provider configuration
 */
export interface ModelProviderConfig {
  /** Provider identifier (e.g., 'openai', 'anthropic', 'ollama') */
  provider: string

  /** Model name (e.g., 'gpt-4o', 'claude-3.5-sonnet', 'llama3') */
  model: string

  /** API endpoint (optional, for custom endpoints) */
  endpoint?: string

  /** API key or token */
  apiKey?: string

  /** Temperature for generation (0-2) */
  temperature?: number

  /** Maximum tokens to generate */
  maxTokens?: number

  /** Top P sampling */
  topP?: number

  /** System prompt */
  systemPrompt?: string

  /** Provider-specific options */
  [key: string]: unknown
}

/**
 * Chat message for LLM interactions
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  name?: string
}

/**
 * LLM completion result
 */
export interface LlmCompletion {
  /** Generated text */
  content: string

  /** Model used */
  model: string

  /** Token usage */
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }

  /** Finish reason */
  finishReason?: string

  /** Raw response (for debugging) */
  raw?: unknown
}

/**
 * Model provider interface
 */
export interface ModelProvider {
  /** Provider identifier */
  readonly id: string

  /** Provider name */
  readonly name: string

  /** Initialize with configuration */
  initialize(config: ModelProviderConfig): Promise<void>

  /** Generate completion */
  complete(messages: ChatMessage[], options?: Partial<ModelProviderConfig>): Promise<LlmCompletion>

  /** Generate completion with streaming */
  completeStream?(
    messages: ChatMessage[],
    options?: Partial<ModelProviderConfig>,
  ): AsyncIterable<string>

  /** Check health */
  healthCheck(): Promise<{ healthy: boolean; status: string }>

  /** List available models */
  listModels?(): Promise<string[]>

  /** Get current configuration */
  getConfig(): ModelProviderConfig
}

/**
 * Base class for model providers
 */
export abstract class ModelProviderBase implements ModelProvider {
  abstract readonly id: string
  abstract readonly name: string

  protected config: ModelProviderConfig | null = null
  protected initialized = false

  async initialize(config: ModelProviderConfig): Promise<void> {
    this.config = config
    this.initialized = true
    await this.doInitialize(config)
  }

  abstract doInitialize(config: ModelProviderConfig): Promise<void>

  async complete(
    messages: ChatMessage[],
    options?: Partial<ModelProviderConfig>,
  ): Promise<LlmCompletion> {
    if (!this.initialized) {
      throw new Error(`Model provider not initialized: ${this.id}`)
    }
    return this.doComplete(messages, options)
  }

  abstract doComplete(
    messages: ChatMessage[],
    options?: Partial<ModelProviderConfig>,
  ): Promise<LlmCompletion>

  async healthCheck(): Promise<{ healthy: boolean; status: string }> {
    return { healthy: this.initialized, status: this.initialized ? 'ready' : 'not-initialized' }
  }

  getConfig(): ModelProviderConfig {
    if (!this.config) {
      throw new Error(`Model provider not initialized: ${this.id}`)
    }
    return this.config
  }
}

/**
 * Model registry for managing multiple providers
 */
export class ModelRegistry {
  private readonly providers = new Map<string, ModelProvider>()
  private defaultProvider: string | undefined

  /**
   * Register a model provider
   */
  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Model provider already registered: ${provider.id}`)
    }
    this.providers.set(provider.id, provider)
  }

  /**
   * Get a model provider by ID
   */
  get(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId)
  }

  /**
   * Set default provider
   */
  setDefault(providerId: string): void {
    this.defaultProvider = providerId
  }

  /**
   * Get default provider
   */
  getDefault(): ModelProvider | undefined {
    if (this.defaultProvider) {
      return this.providers.get(this.defaultProvider)
    }
    return this.providers.values().next().value
  }

  /**
   * List all registered providers
   */
  list(): readonly ModelProvider[] {
    return [...this.providers.values()]
  }

  /**
   * Initialize all providers
   */
  async initializeAll(configs: Record<string, ModelProviderConfig>): Promise<void> {
    for (const provider of this.providers.values()) {
      const config = configs[provider.id]
      if (config) {
        await provider.initialize(config)
      }
    }
  }

  /**
   * Health check all providers
   */
  async healthCheckAll(): Promise<Record<string, { healthy: boolean; status: string }>> {
    const results: Record<string, { healthy: boolean; status: string }> = {}
    for (const provider of this.providers.values()) {
      try {
        results[provider.id] = await provider.healthCheck()
      } catch (error) {
        results[provider.id] = {
          healthy: false,
          status: `error: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    return results
  }

  /**
   * Dispose all providers
   */
  async dispose(): Promise<void> {
    this.providers.clear()
    this.defaultProvider = undefined
  }
}

/**
 * Execute an LLM step using the model registry
 */
export async function executeLlmStep(
  step: LlmStep,
  ctx: Context,
  registry: ModelRegistry,
): Promise<LlmCompletion> {
  const explicit = typeof step.backend === 'string' ? step.backend : step.backend?.[0]
  const providerId = explicit || (registry.getDefault()?.id as string | undefined)
  if (!providerId) {
    throw new Error('No model provider specified or available')
  }

  const provider = registry.get(providerId)
  if (!provider) {
    throw new Error(`Model provider not found: ${providerId}`)
  }

  const messages: ChatMessage[] = []

  if (step.system) {
    const systemPrompt = await (typeof step.system === 'function' ? step.system(ctx) : step.system)
    messages.push({ role: 'system', content: systemPrompt })
  }

  // Add current prompt — the ModelRegistry path predates multimodal prompts
  // and only accepts string content; collapse any image-bearing prompt to its
  // text components. Vision callers should target a vision-capable backend
  // via the BackendRegistry/llm() path. Function form may be async since
  // multimodal authoring sometimes loads bytes from disk in the resolver.
  const promptValue = await (typeof step.prompt === 'function' ? step.prompt(ctx) : step.prompt)
  const prompt =
    typeof promptValue === 'string'
      ? promptValue
      : promptValue
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('')
  messages.push({ role: 'user', content: prompt })

  const options: Partial<ModelProviderConfig> = {}
  if (step.temperature !== undefined) options.temperature = step.temperature
  if (step.maxTokens !== undefined) options.maxTokens = step.maxTokens

  return provider.complete(messages, options)
}

/**
 * Resolve template variables in prompt (deprecated - use step functions directly)
 */
function resolveTemplate(template: string, ctx: Context): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = ctx.steps?.[key]
    return value !== undefined ? String(value) : `{{${key}}}`
  })
}
