import { runWithMemoryTurns } from '@skelm/agentmemory'
import {
  BackendCapabilityError,
  combineSignals,
  extractJsonFromText,
  toErrorMessage,
  validate,
} from '@skelm/core'
import type { AgentRequest, AgentResponse, BackendContext } from '@skelm/core'
import { type ModelMessage, Output, generateText, stepCountIs, streamText } from 'ai'
import { VercelAiBackendError, VercelAiBackendTimeoutError } from './errors.js'
import { mapMessages, mapUsage } from './inference.js'
import { applyPolicyToTools, assertEgressEnforceable } from './permissions.js'
import { buildSystemContent, loadSkillBodies } from './skill-injection.js'
import type { VercelAiBackendOptions } from './types.js'
import { assertModelSupportsImages } from './vision-gate.js'

export async function vercelAiRun(
  options: VercelAiBackendOptions,
  request: AgentRequest,
  context: BackendContext,
): Promise<AgentResponse> {
  const policy = context.permissions ?? request.permissions
  // vercel-ai is in-process; the AI SDK's outbound HTTP does not honor
  // HTTP_PROXY env vars from the gateway egress proxy. Fail-closed instead
  // of pretending to enforce networkEgress.
  assertEgressEnforceable(policy)
  // Per-model vision check (F123 / #177): when the backend declares a
  // visionModels allowlist, fail loudly *before* dispatch instead of letting
  // the upstream silently strip images and hallucinate.
  // (The agent() path has no `model` field on AgentRequest today, so the
  // F133 per-call override guard only fires on the infer()/infer() path —
  // see inference.ts.)
  assertModelSupportsImages({
    backendId: 'vercel-ai',
    model: options.model,
    visionModels: options.visionModels,
    prompt: request.prompt,
  })
  const tools = applyPolicyToTools(options.tools, policy)

  const memoryProject = request.cwd ?? process.cwd()
  const skillBodies = await loadSkillBodies(request, context)
  const baseSystem = buildSystemContent(options.systemPrompt, request, skillBodies)

  const timeout = options.timeout ?? 300_000
  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(new Error('vercel-ai run timed out')), timeout)
  const signal = combineSignals(context.signal, timeoutCtl.signal)

  const maxTurns = request.maxTurns ?? 8

  // Map text vs multimodal prompt to the AI SDK shape: prompt: string, or
  // messages: ModelMessage[] when image parts are present.
  const promptOrMessages: { prompt: string } | { messages: ModelMessage[] } =
    typeof request.prompt === 'string'
      ? { prompt: request.prompt }
      : { messages: mapMessages([{ role: 'user', content: request.prompt }]) }

  try {
    return await runWithMemoryTurns<AgentResponse>(
      {
        handle: context.agentmemory,
        ...(context.runId !== undefined && { runId: context.runId }),
        ...(context.stepId !== undefined && { stepId: context.stepId }),
        project: memoryProject,
      },
      request,
      async ({ recallPrefix }) => {
        const system =
          recallPrefix.length > 0
            ? baseSystem === undefined
              ? recallPrefix
              : `${recallPrefix}${baseSystem}`
            : baseSystem
        const response = await dispatchVercelAi({
          options,
          request,
          context,
          system,
          tools,
          promptOrMessages,
          maxTurns,
          signal,
        })
        return { result: response, resultText: response.text ?? '' }
      },
    )
  } catch (err) {
    if (timeoutCtl.signal.aborted) {
      throw new VercelAiBackendTimeoutError(`vercel-ai run timed out after ${timeout}ms`, err)
    }
    if (err instanceof BackendCapabilityError) throw err
    if (err instanceof VercelAiBackendError) throw err
    throw new VercelAiBackendError(`vercel-ai agent run failed: ${toErrorMessage(err)}`, err)
  } finally {
    clearTimeout(timer)
  }
}

interface DispatchParams {
  options: VercelAiBackendOptions
  request: AgentRequest
  context: BackendContext
  system: string | undefined
  tools: ReturnType<typeof applyPolicyToTools>
  promptOrMessages: { prompt: string } | { messages: ModelMessage[] }
  maxTurns: number
  signal: AbortSignal
}

async function dispatchVercelAi(p: DispatchParams): Promise<AgentResponse> {
  const { options, request, context, system, tools, promptOrMessages, maxTurns, signal } = p
  {
    if (context.onPartial !== undefined) {
      // Streaming path: use streamText to emit partial chunks as they arrive.
      // onError captures upstream errors instead of letting the AI SDK dump
      // a stack trace to stderr. We re-raise the captured error after the
      // textStream completes so the step is marked failed with a clean
      // message ("OpenAI-compatible request failed (400): image input is
      // not supported" etc.) and the gateway/CLI report a usable cause.
      //
      // Race-free: the AI SDK invokes onError synchronously from inside its
      // stream processing (not via a separate microtask) and the textStream
      // iterator stops yielding once an error fires, so the post-loop check
      // is guaranteed to see `streamError` populated when termination was
      // due to error. See inference.ts for the same reasoning.
      let streamError: unknown
      const stream = streamText({
        model: options.model,
        ...(system !== undefined ? { system } : {}),
        ...promptOrMessages,
        ...(Object.keys(tools).length > 0 ? { tools } : {}),
        stopWhen: stepCountIs(maxTurns),
        ...(request.outputSchema !== undefined && {
          // biome-ignore lint/suspicious/noExplicitAny: SkelmSchema → FlexibleSchema; SDK generic plumbing is loose
          output: Output.object({ schema: request.outputSchema as any }),
        }),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
        ...(options.providerOptions !== undefined
          ? // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions is JSONObject; we accept a looser shape for ergonomics
            { providerOptions: options.providerOptions as any }
          : {}),
        abortSignal: signal,
        onError: ({ error }) => {
          streamError = error
        },
      })

      let fullText = ''
      for await (const chunk of stream.textStream) {
        fullText += chunk
        context.onPartial(chunk)
      }
      if (streamError !== undefined) {
        throw new VercelAiBackendError(
          `vercel-ai stream failed: ${toErrorMessage(streamError)}`,
          streamError,
        )
      }
      const finalResult = await stream
      const finishReason = await stream.finishReason
      const finalUsage = await stream.usage
      if (finishReason === 'error') {
        throw new VercelAiBackendError(`vercel-ai stream terminated with finishReason='error'`)
      }

      const response: AgentResponse = {}
      if (typeof finishReason === 'string') response.stopReason = finishReason
      const usage = mapUsage(finalUsage)
      if (usage !== undefined) response.usage = usage

      if (request.outputSchema !== undefined) {
        const output = (finalResult as { output?: unknown }).output
        if (output !== undefined && output !== null && typeof output === 'object') {
          // Validate against the schema to distinguish a genuine structured result
          // (including valid empty objects like z.object({})) from the {} that
          // local OpenAI-compatible endpoints return when they don't support JSON mode.
          try {
            await validate(request.outputSchema, output, 'output')
            response.structured = output
          } catch {
            // output={} was a provider stub. Parse the text stream to satisfy the
            // structured-output contract so callers always see response.structured.
            try {
              const candidate = extractJsonFromText(fullText)
              response.structured = await validate(request.outputSchema, candidate, 'output')
            } catch {
              // Text also doesn't satisfy the schema — surface it as text and let
              // the runner produce a SchemaValidationError with full context.
              response.text = fullText
            }
          }
        } else {
          response.text = fullText
        }
      } else {
        response.text = fullText
      }
      return response
    }

    // Non-streaming path: use generateText.
    const result = await generateText({
      model: options.model,
      ...(system !== undefined ? { system } : {}),
      ...promptOrMessages,
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      stopWhen: stepCountIs(maxTurns),
      ...(request.outputSchema !== undefined && {
        // biome-ignore lint/suspicious/noExplicitAny: SkelmSchema → FlexibleSchema; SDK generic plumbing is loose
        output: Output.object({ schema: request.outputSchema as any }),
      }),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      ...(options.providerOptions !== undefined
        ? // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions is JSONObject; we accept a looser shape for ergonomics
          { providerOptions: options.providerOptions as any }
        : {}),
      abortSignal: signal,
    })

    if ((result as { finishReason?: string }).finishReason === 'error') {
      // AI SDK occasionally reports terminal errors via finishReason='error'
      // without rejecting; treat that as a thrown failure so the step is
      // marked failed rather than completed with empty text.
      throw new VercelAiBackendError(`vercel-ai run terminated with finishReason='error'`)
    }
    const response: AgentResponse = {}
    if (typeof result.finishReason === 'string') response.stopReason = result.finishReason
    const usage = mapUsage(result.usage)
    if (usage !== undefined) response.usage = usage

    if (request.outputSchema !== undefined) {
      const output = (result as { output?: unknown }).output
      // generateText with Output.object() validates internally and throws if the
      // schema doesn't match, so output here is always schema-valid (including {}).
      if (output !== undefined && output !== null && typeof output === 'object') {
        response.structured = output
      } else {
        response.text = result.text
      }
    } else {
      response.text = result.text
    }
    return response
  }
}
