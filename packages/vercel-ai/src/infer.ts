import type { BackendContext, InferRequest, InferResponse, PromptMessage, Usage } from '@skelm/core'
import { type ModelMessage, generateObject, generateText, streamText } from 'ai'
import { VercelAiBackendError, VercelAiBackendTimeoutError } from './errors.js'
import { assertEgressEnforceable } from './permissions.js'
import type { VercelAiBackendOptions } from './types.js'

export async function vercelAiInfer(
  options: VercelAiBackendOptions,
  request: InferRequest,
  context: BackendContext,
): Promise<InferResponse> {
  // vercel-ai is in-process; the AI SDK's outbound HTTP does not honor
  // HTTP_PROXY env vars from the gateway egress proxy. Fail-closed instead
  // of pretending to enforce networkEgress.
  assertEgressEnforceable(context.permissions)
  const messages = mapMessages(request.messages)
  const timeout = options.timeout ?? 300_000
  const timeoutCtl = new AbortController()
  const timer = setTimeout(
    () => timeoutCtl.abort(new Error('vercel-ai inference timed out')),
    timeout,
  )
  const signal = combineSignals(context.signal, timeoutCtl.signal)

  // Build the call settings shared by both generateText and generateObject.
  const baseCall = {
    model: options.model,
    messages,
    ...(request.system !== undefined ? { system: request.system } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.providerOptions !== undefined
      ? // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions is JSONObject; we accept a looser shape for ergonomics
        { providerOptions: options.providerOptions as any }
      : {}),
    abortSignal: signal,
  }

  try {
    if (request.outputSchema !== undefined) {
      // Schema path: route through generateObject so the AI SDK uses the
      // provider's native structured-output mode (function-calling /
      // response_format / etc.) rather than free-form text. This makes the
      // call robust against smaller open-weight models (qwen, llama, …) that
      // would otherwise emit terse plain text the previous parseStructured
      // helper rejected. SkelmSchema is StandardSchemaV1, which the SDK
      // accepts directly via FlexibleSchema.
      const objectResult = await generateObject({
        ...baseCall,
        // biome-ignore lint/suspicious/noExplicitAny: see above
        schema: request.outputSchema as any,
      })
      const response: InferResponse = { structured: objectResult.object }
      const usage = mapUsage(objectResult.usage)
      if (usage !== undefined) response.usage = usage
      return response
    }

    // No schema: free-form text.
    if (context.onPartial !== undefined) {
      // Streaming path: use streamText to emit partial chunks as they arrive.
      const stream = streamText({ ...baseCall })
      let fullText = ''
      for await (const chunk of stream.textStream) {
        fullText += chunk
        context.onPartial(chunk)
      }
      const finalResult = await stream
      const response: InferResponse = { text: fullText }
      const usage = mapUsage(finalResult.usage)
      if (usage !== undefined) response.usage = usage
      return response
    }
    // Non-streaming path: use generateText.
    const textResult = await generateText(baseCall)
    const response: InferResponse = { text: textResult.text }
    const usage = mapUsage(textResult.usage)
    if (usage !== undefined) response.usage = usage
    return response
  } catch (err) {
    if (timeoutCtl.signal.aborted) {
      throw new VercelAiBackendTimeoutError(`vercel-ai inference timed out after ${timeout}ms`, err)
    }
    if (err instanceof VercelAiBackendError) throw err
    throw new VercelAiBackendError(`vercel-ai inference failed: ${(err as Error).message}`, err)
  } finally {
    clearTimeout(timer)
  }
}

function mapMessages(messages: readonly PromptMessage[]): ModelMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content }
      case 'user':
        return { role: 'user', content: m.content }
      case 'assistant':
        return { role: 'assistant', content: m.content }
      case 'tool':
        // Skelm tool messages collapse to user-text for v1 — tool-result rounds
        // are handled inside generateText's own loop in run().
        return { role: 'user', content: m.content }
    }
  })
}

export function mapUsage(v: unknown): Usage | undefined {
  if (v === null || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const out: Usage = {}
  if (typeof o.inputTokens === 'number') out.inputTokens = o.inputTokens
  if (typeof o.outputTokens === 'number') out.outputTokens = o.outputTokens
  if (typeof o.cachedInputTokens === 'number') out.cachedInputTokens = o.cachedInputTokens
  if (typeof o.reasoningTokens === 'number') out.reasoningTokens = o.reasoningTokens
  return Object.keys(out).length > 0 ? out : undefined
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
