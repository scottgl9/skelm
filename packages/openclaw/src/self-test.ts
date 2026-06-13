/**
 * Self-test: a representative inbound → run → status → deliver loop against the
 * in-process {@link FakeGatewayClient}. No real gateway and no network. Returns
 * a structured report a host can assert on; throws {@link OpenClawSelfTestError}
 * on the first failed expectation.
 *
 * It exercises the full bridge contract: an inbound OpenClaw message normalized
 * into a trigger input, a synchronous run, a status read, and delivery of the
 * result back to the originating channel with audit references preserved.
 */

import type { InboundEvent } from '@skelm/integration-sdk'
import type { OutboundEvent } from '@skelm/integration-sdk'
import { deliverResult } from './delivery.js'
import { normalizeInbound } from './inbound.js'
import { FakeGatewayClient } from './testing.js'
import { skelmRun, skelmStatus } from './tools.js'

export class OpenClawSelfTestError extends Error {
  override readonly name = 'OpenClawSelfTestError'
}

export interface SelfTestReport {
  readonly runId: string
  readonly delivered: OutboundEvent
  readonly auditPreserved: boolean
}

export async function runSelfTest(): Promise<SelfTestReport> {
  const runId = 'run_selftest_1'
  const client = new FakeGatewayClient()
    .on('POST', '/pipelines/hello.workflow.ts/run', {
      body: { runId, status: 'completed', output: { reply: 'hi there' } },
    })
    .on('GET', `/runs/${runId}/events`, {
      body: { runId, events: [{ type: 'run.completed' }] },
    })

  const inbound: InboundEvent = {
    provider: 'openclaw',
    eventId: 'evt_1',
    type: 'message',
    target: { conversationId: 'chan_42', userId: 'user_7' },
    text: 'run hello',
    at: 1_700_000_000_000,
  }

  const { input, deliveryTarget } = normalizeInbound(inbound)
  if (input.conversationId !== 'chan_42') {
    throw new OpenClawSelfTestError('inbound normalization lost conversationId')
  }

  const run = await skelmRun(client, { workflowId: 'hello.workflow.ts', input })
  if (run.refs.runId !== runId) {
    throw new OpenClawSelfTestError('skelm_run did not surface runId')
  }

  const status = await skelmStatus(client, { runId })
  if (status.refs.runId !== runId) {
    throw new OpenClawSelfTestError('skelm_status did not surface runId')
  }

  let delivered: OutboundEvent | undefined
  const refs = await deliverResult(
    (event) => {
      delivered = event
    },
    run,
    deliveryTarget,
  )

  if (delivered === undefined) throw new OpenClawSelfTestError('result was not delivered')
  if (delivered.target.conversationId !== 'chan_42') {
    throw new OpenClawSelfTestError('delivery landed on the wrong channel')
  }
  const carried = (delivered.providerOptions?.skelmRefs as { runId?: string } | undefined)?.runId
  if (refs.runId !== runId || carried !== runId) {
    throw new OpenClawSelfTestError('audit refs were not preserved through delivery')
  }

  return { runId, delivered, auditPreserved: true }
}
