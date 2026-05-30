import { createConcurrencySemaphore } from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  InferenceRequest,
  InferenceResponse,
  SkelmBackend,
} from '@skelm/core'
import { vercelAiInference } from './inference.js'
import { vercelAiRun } from './run.js'
import type { VercelAiBackendOptions } from './types.js'

/**
 * Create a SkelmBackend backed by a Vercel AI SDK LanguageModel.
 *
 * Powers both `infer()` (via generateText) and `agent()` (via generateText with
 * tools and stepCountIs). Tool permissions are enforced natively by filtering
 * the tool set against the resolved policy and re-checking at execute() time.
 *
 * Streaming and MCP are not yet supported — declare capabilities accordingly.
 *
 * @example
 *   import { openai } from '@ai-sdk/openai'
 *   const backend = createVercelAiBackend({ model: openai('gpt-4o-mini') })
 */
export function createVercelAiBackend(options: VercelAiBackendOptions): SkelmBackend {
  const capabilities: BackendCapabilities = {
    prompt: true,
    streaming: true, // supports onPartial via streamText
    sessionLifecycle: false,
    mcp: false,
    skills: true,
    modelSelection: false,
    toolPermissions: 'native',
    // Vercel AI SDK forwards image parts to the underlying provider; visibility
    // depends on the model. Declared true here — pair with an image-capable
    // model (e.g. openai('gpt-4o-mini'), anthropic('claude-3-5-sonnet-latest')).
    vision: true,
    // run() wires the agentmemory turn lifecycle (see ./run.ts). Required
    // for the runtime capability gate to allow agentmemory-permitted
    // steps to dispatch here.
    agentmemory: true,
  }

  const { acquire, release } = createConcurrencySemaphore(options.maxConcurrent ?? 4)

  return {
    id: options.id ?? 'vercel-ai',
    label: options.label ?? 'Vercel AI SDK',
    capabilities,

    async inference(
      request: InferenceRequest,
      context: BackendContext,
    ): Promise<InferenceResponse> {
      await acquire()
      try {
        return await vercelAiInference(options, request, context)
      } finally {
        release()
      }
    },

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      await acquire()
      try {
        return await vercelAiRun(options, request, context)
      } finally {
        release()
      }
    },
  }
}
