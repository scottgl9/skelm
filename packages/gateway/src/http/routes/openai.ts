import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import { runPipelineSync } from './pipeline-runner.js'
import { openaiContentFor } from './utils.js'

export function registerOpenAIRoutes(router: Router, gateway: Gateway): void {
  router.post(
    '/v1/chat/completions',
    eventHandler(async (event) => {
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object'
          ? (rawBody as { model?: unknown; messages?: unknown })
          : {}
      if (typeof body.model !== 'string' || body.model === '') {
        throw createError({ statusCode: 400, message: 'model required' })
      }
      if (!Array.isArray(body.messages)) {
        throw createError({ statusCode: 400, message: 'messages must be an array' })
      }
      const final = await runPipelineSync(gateway, body.model, { messages: body.messages })
      const content = openaiContentFor(final.output)
      return {
        id: `chatcmpl-${final.runId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: final.status === 'completed' ? 'stop' : 'error',
          },
        ],
        ...(final.error !== undefined && {
          error: { message: final.error.message ?? String(final.error), type: 'pipeline_error' },
        }),
      }
    }),
  )

  router.post(
    '/v1/responses',
    eventHandler(async (event) => {
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object'
          ? (rawBody as { model?: unknown; input?: unknown })
          : {}
      if (typeof body.model !== 'string' || body.model === '') {
        throw createError({ statusCode: 400, message: 'model required' })
      }
      const input = body.input
      const pipelineInput =
        typeof input === 'string'
          ? { messages: [{ role: 'user', content: input }] }
          : Array.isArray(input)
            ? { messages: input }
            : input !== undefined && typeof input === 'object'
              ? (input as Record<string, unknown>)
              : {}
      const final = await runPipelineSync(gateway, body.model, pipelineInput)
      const content = openaiContentFor(final.output)
      return {
        id: `resp-${final.runId}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: body.model,
        status: final.status === 'completed' ? 'completed' : 'failed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] },
        ],
        ...(final.error !== undefined && {
          error: { message: final.error.message ?? String(final.error) },
        }),
      }
    }),
  )
}
