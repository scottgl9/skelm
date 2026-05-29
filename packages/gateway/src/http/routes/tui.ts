import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import { decodeMaybe } from './utils.js'

interface SubmitBody {
  sessionId?: unknown
  text?: unknown
  from?: unknown
}

interface RemoteTuiDriver {
  transport?: string
  submit?(input: { sessionId: string; text: string; from?: string }): Promise<{ reply: string }>
}

/**
 * POST /v1/tui/:sourceId/submit — inject one user line into a CLI-hosted TUI
 * session and return the workflow's reply. The terminal UI lives in the
 * `skelm run` process; this drives the gateway-side headless TUI source
 * (createRemoteTriggerSource) which fires the persistent workflow and returns
 * the turn's reply.
 */
export function registerTuiRoutes(router: Router, gateway: Gateway): void {
  router.post(
    '/v1/tui/:sourceId/submit',
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
        | RemoteTuiDriver
        | undefined
      if (
        driver === undefined ||
        driver.transport !== 'tui' ||
        typeof driver.submit !== 'function'
      ) {
        throw createError({ statusCode: 404, message: `no TUI source registered: ${sourceId}` })
      }
      return await driver.submit({
        sessionId: body.sessionId,
        text: body.text,
        ...(typeof body.from === 'string' && { from: body.from }),
      })
    }),
  )
}
