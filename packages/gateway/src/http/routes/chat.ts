import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import { decodeMaybe } from './utils.js'

interface SubmitBody {
  sessionId?: unknown
  text?: unknown
  from?: unknown
}

interface RemoteChatUiDriver {
  transport?: string
  submit?(input: { sessionId: string; text: string; from?: string }): Promise<{ runId: string }>
}

const CHAT_TRANSPORTS = new Set(['tui', 'web'])

/**
 * POST /v1/chat/:sourceId/submit — inject one user line into a client-hosted
 * chat-UI session and return the turn's `{ runId }`. The UI lives in the client
 * (the `skelm run` process for the `tui` transport, a browser for `web`); this
 * drives the gateway-side headless chat-UI source (createRemoteTriggerSource)
 * which fires the workflow and reports the runId so the client can tail
 * `/runs/:runId/stream` for partials and the final reply.
 */
export function registerChatRoutes(router: Router, gateway: Gateway): void {
  router.post(
    '/v1/chat/:sourceId/submit',
    eventHandler(async (event) => {
      const sourceId = decodeMaybe(event.context.params?.sourceId)
      if (sourceId === undefined || sourceId.length === 0) {
        throw createError({ statusCode: 400, message: 'sourceId is required' })
      }
      const body = ((await readBody(event).catch(() => ({}))) ?? {}) as SubmitBody
      if (typeof body.sessionId !== 'string' || typeof body.text !== 'string') {
        throw createError({ statusCode: 400, message: 'sessionId and text are required' })
      }
      const driver = gateway.managers.triggers.getQueueDriver(sourceId) as
        | RemoteChatUiDriver
        | undefined
      if (
        driver === undefined ||
        typeof driver.transport !== 'string' ||
        !CHAT_TRANSPORTS.has(driver.transport) ||
        typeof driver.submit !== 'function'
      ) {
        throw createError({ statusCode: 404, message: `no chat-UI source registered: ${sourceId}` })
      }
      return await driver.submit({
        sessionId: body.sessionId,
        text: body.text,
        ...(typeof body.from === 'string' && { from: body.from }),
      })
    }),
  )
}
