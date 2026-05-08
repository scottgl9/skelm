import type { AgentRequest, AgentResponse, BackendContext } from '@skelm/core'
import { Output, generateText, stepCountIs, streamText } from 'ai'
import { VercelAiBackendError, VercelAiBackendTimeoutError } from './errors.js'
import { mapUsage } from './infer.js'
import { applyPolicyToTools, assertEgressEnforceable } from './permissions.js'
import { buildSystemContent, loadSkillBodies } from './skill-injection.js'
import type { VercelAiBackendOptions } from './types.js'

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
  const tools = applyPolicyToTools(options.tools, policy)

  const skillBodies = await loadSkillBodies(request, context)
  const system = buildSystemContent(options.systemPrompt, request, skillBodies)

  const timeout = options.timeout ?? 300_000
  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(new Error('vercel-ai run timed out')), timeout)
  const signal = combineSignals(context.signal, timeoutCtl.signal)

  const maxTurns = request.maxTurns ?? 8

  try {
    // When the step declares an `output` schema, route through the AI SDK's
    // `Output.object({ schema })` adapter so the underlying provider uses
    // its native structured-output mode (function-calling /
    // response_format / etc.) for the final answer. This keeps tool calls
    // working during the loop AND eliminates the previous parseStructured
    // fallback that rejected plain text from smaller open-weight models
    // (qwen, llama, …) that didn't always wrap responses in JSON.
    //
    // SkelmSchema is StandardSchemaV1, which the SDK accepts directly via
    // FlexibleSchema.

    if (context.onPartial !== undefined) {
      // Streaming path: use streamText to emit partial chunks as they arrive.
      const stream = streamText({
        model: options.model,
        ...(system !== undefined ? { system } : {}),
        prompt: request.prompt,
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

      let fullText = ''
      for await (const chunk of stream.textStream) {
        fullText += chunk
        context.onPartial(chunk)
      }
      const finalResult = await stream

      const response: AgentResponse = {}
      if (typeof finalResult.finishReason === 'string')
        response.stopReason = finalResult.finishReason
      const usage = mapUsage(finalResult.usage)
      if (usage !== undefined) response.usage = usage

      if (request.outputSchema !== undefined) {
        response.structured = (finalResult as { output?: unknown }).output
      } else {
        response.text = fullText
      }
      return response
    }

    // Non-streaming path: use generateText.
    const result = await generateText({
      model: options.model,
      ...(system !== undefined ? { system } : {}),
      prompt: request.prompt,
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

    const response: AgentResponse = {}
    if (typeof result.finishReason === 'string') response.stopReason = result.finishReason
    const usage = mapUsage(result.usage)
    if (usage !== undefined) response.usage = usage

    if (request.outputSchema !== undefined) {
      // result.output is the typed object produced by the Output.object
      // adapter; the SDK has already validated against the schema.
      response.structured = (result as { output?: unknown }).output
    } else {
      response.text = result.text
    }
    return response
  } catch (err) {
    if (timeoutCtl.signal.aborted) {
      throw new VercelAiBackendTimeoutError(`vercel-ai run timed out after ${timeout}ms`, err)
    }
    if (err instanceof VercelAiBackendError) throw err
    throw new VercelAiBackendError(`vercel-ai agent run failed: ${(err as Error).message}`, err)
  } finally {
    clearTimeout(timer)
  }
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (a === undefined) return b
  if (a.aborted) return a
  const ctl = new AbortController()
  const onA = () => ctl.abort(a.reason)
  const onB = () => ctl.abort(b.reason)
  a.addEventListener('abort', onA, { once: true })
  b.addEventListener('abort', onB, { once: true })
  return ctl.signal
}
