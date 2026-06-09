import { type H3Event, type Router, createError, eventHandler, readBody } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

export function registerApprovalRoutes(router: Router, gateway: GatewayContext): void {
  router.get(
    '/approvals',
    eventHandler(async () => {
      const gate = gateway.enforcement.approvalGate as {
        list?: () => Array<{ id: string; request: unknown; createdAt: string }>
      }
      if (typeof gate.list !== 'function') return []
      return gate.list()
    }),
  )

  router.post(
    '/runs/:runId/approve',
    eventHandler(async (event: H3Event) => deliverApproval(event, gateway, true)),
  )

  router.post(
    '/runs/:runId/deny',
    eventHandler(async (event: H3Event) => deliverApproval(event, gateway, false)),
  )
}

async function deliverApproval(
  event: H3Event,
  gateway: GatewayContext,
  approve: boolean,
): Promise<{ delivered: boolean }> {
  const runId = event.context.params?.runId
  if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
  const body = (await readBody(event).catch(() => ({}))) as {
    stepId?: string
    approver?: string
    reason?: string
  }
  if (!body.stepId) throw createError({ statusCode: 400, message: 'stepId required' })
  const id = `${runId}:${body.stepId}`
  const gate = gateway.enforcement.approvalGate as {
    approve?: (id: string, approver?: string, reason?: string) => boolean
    deny?: (id: string, approver?: string, reason?: string) => boolean
  }
  const fn = approve ? gate.approve : gate.deny
  if (typeof fn !== 'function') {
    throw createError({ statusCode: 501, message: 'configured approval gate is not interactive' })
  }
  const delivered = fn.call(gate, id, body.approver, body.reason)
  if (!delivered) throw createError({ statusCode: 404, message: 'no pending approval' })
  return { delivered }
}
