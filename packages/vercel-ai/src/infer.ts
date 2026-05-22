import { combineSignals, isMultimodal } from '@skelm/core'
import type {
  BackendContext,
  ContentPart,
  InferRequest,
  InferResponse,
  PromptMessage,
  Usage,
} from '@skelm/core'
import { type ModelMessage, generateObject, generateText, streamText } from 'ai'
import { VercelAiBackendError, VercelAiBackendTimeoutError } from './errors.js'
import { assertEgressEnforceable } from './permissions.js'
import type { VercelAiBackendOptions } from './types.js'
import { assertModelMatchesBound, assertModelSupportsImages } from './vision-gate.js'

export async function vercelAiInfer(
  options: VercelAiBackendOptions,
  request: InferRequest,
  context: BackendContext,
): Promise<InferResponse> {
  // vercel-ai is in-process; the AI SDK's outbound HTTP does not honor
  // HTTP_PROXY env vars from the gateway egress proxy. Fail-closed instead
  // of pretending to enforce networkEgress.
  assertEgressEnforceable(context.permissions)
  // Per-call model override guard (F133): vercel-ai binds a LanguageModel
  // at construction time and cannot route req.model to a different
  // upstream — silently honouring the bound model would mask routing
  // mistakes (e.g. asking for a text model on a vision-bound backend and
  // getting the vision model's reply).
  assertModelMatchesBound('vercel-ai', options.model, request.model)
  // Per-model vision check (F123 / #177): when the backend declares a
  // visionModels allowlist, fail loudly *before* dispatch instead of letting
  // the upstream silently strip images and hallucinate.
  assertModelSupportsImages({
    backendId: 'vercel-ai',
    model: options.model,
    visionModels: options.visionModels,
    messages: request.messages,
  })
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
      // Provide an onError sink to capture upstream errors without letting
      // the AI SDK dump a full stack trace to stderr. We re-raise the
      // captured error after the iterator completes so the step is marked
      // failed with a clean message.
      //
      // The post-iterator check `if (streamError !== undefined)` is race-free:
      // the AI SDK calls `onError` synchronously from inside its stream
      // processing (not on a separate microtask), and the `textStream`
      // iterator does not yield further chunks after the error fires. By the
      // time `for await` exits we have either (a) seen the full text with no
      // error, or (b) a populated `streamError` and a possibly partial
      // `fullText` — either way the subsequent throw runs in the same tick
      // as the iterator's completion.
      let streamError: unknown
      const stream = streamText({
        ...baseCall,
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
        throw streamError instanceof Error ? streamError : new Error(String(streamError))
      }
      // Await the resolved Promises explicitly so upstream errors propagate
      // as a rejection rather than being swallowed into an empty result. The
      // AI SDK surfaces transport errors via the .finishReason / .usage
      // promises, which reject when the stream terminated due to an error.
      const finishReason = await stream.finishReason
      const finalUsage = await stream.usage
      if (finishReason === 'error') {
        // Defensive: in case the SDK reports 'error' without rejecting, raise
        // so callers see a thrown error instead of an empty text result.
        throw new Error(`vercel-ai stream terminated with finishReason='error'`)
      }
      const response: InferResponse = { text: fullText }
      const usage = mapUsage(finalUsage)
      if (usage !== undefined) response.usage = usage
      return response
    }
    // Non-streaming path: use generateText.
    const textResult = await generateText(baseCall)
    if ((textResult as { finishReason?: string }).finishReason === 'error') {
      // AI SDK occasionally reports terminal errors via finishReason='error'
      // without rejecting the promise; treat that as a thrown failure so the
      // step is marked failed rather than completed with empty text.
      throw new Error(`vercel-ai generateText terminated with finishReason='error'`)
    }
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

export function mapMessages(messages: readonly PromptMessage[]): ModelMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: collapseText(m.content) }
      case 'user':
        return isMultimodal(m.content)
          ? { role: 'user', content: toVercelUserParts(m.content) }
          : { role: 'user', content: m.content }
      case 'assistant':
        return { role: 'assistant', content: collapseText(m.content) }
      case 'tool':
        // Skelm tool messages collapse to user-text for v1 — tool-result rounds
        // are handled inside generateText's own loop in run().
        return { role: 'user', content: collapseText(m.content) }
    }
  })
}

function collapseText(content: PromptMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function toVercelUserParts(
  parts: readonly ContentPart[],
): Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }> {
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image',
          image: `data:${part.mimeType};base64,${part.data}`,
          mediaType: part.mimeType,
        },
  )
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
