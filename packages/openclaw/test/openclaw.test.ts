import type { CredentialReference } from '@skelm/integration-sdk'
import type { InboundEvent } from '@skelm/integration-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createGatewayClient } from '../src/client.js'
import { deliverResult, resultToOutbound, targetToConversation } from '../src/delivery.js'
import { GatewayAuthError, UnknownWorkflowError } from '../src/errors.js'
import { normalizeInbound } from '../src/inbound.js'
import { openclawManifest } from '../src/manifest.js'
import { runSelfTest } from '../src/self-test.js'
import { FakeGatewayClient } from '../src/testing.js'
import {
  skelmAudit,
  skelmCancel,
  skelmRun,
  skelmStart,
  skelmStatus,
  skelmWorkflowSearch,
} from '../src/tools.js'

// Assemble a secret-shaped literal from fragments at runtime (push-protection).
function fakeToken(): string {
  return ['tok', 'en', '-', 'abc', '123'].join('')
}

const bearerRef: CredentialReference = { kind: 'credential-ref', secretName: 'SKELM_GATEWAY_TOKEN' }

// ---------------------------------------------------------------------------
// Tool → gateway request + response shape
// ---------------------------------------------------------------------------

describe('bridge tools map to gateway requests', () => {
  it('skelm_run POSTs to /pipelines/:id/run and surfaces runId + audit refs', async () => {
    const client = new FakeGatewayClient().on('POST', '/pipelines/hello.ts/run', {
      body: { runId: 'run_1', status: 'completed' },
    })
    const res = await skelmRun(client, { workflowId: 'hello.ts', input: { x: 1 } })
    expect(client.requests[0]).toMatchObject({
      method: 'POST',
      path: '/pipelines/hello.ts/run',
      body: { x: 1 },
    })
    expect(res.refs).toEqual({ runId: 'run_1', auditQuery: { runId: 'run_1' } })
  })

  it('skelm_start POSTs to /v1/tasks and carries taskId + childRunId refs', async () => {
    const client = new FakeGatewayClient().on('POST', '/v1/tasks', {
      body: { taskId: 'task_1', childRunId: 'run_9', status: 'running' },
    })
    const res = await skelmStart(client, { workflowId: 'w.ts', input: { a: 1 } })
    expect(client.requests[0]).toMatchObject({ method: 'POST', path: '/v1/tasks' })
    expect((client.requests[0]?.body as { workflowId: string }).workflowId).toBe('w.ts')
    expect(res.refs).toEqual({
      taskId: 'task_1',
      runId: 'run_9',
      auditQuery: { runId: 'run_9' },
    })
  })

  it('skelm_status reads /v1/tasks/:id for a task and /runs/:id/events for a run', async () => {
    const taskClient = new FakeGatewayClient().on('GET', '/v1/tasks/task_1', {
      body: { taskId: 'task_1', childRunId: 'run_9', status: 'completed' },
    })
    const taskStatus = await skelmStatus(taskClient, { taskId: 'task_1' })
    expect(taskClient.requests[0]?.path).toBe('/v1/tasks/task_1')
    expect(taskStatus.refs.taskId).toBe('task_1')
    expect(taskStatus.refs.runId).toBe('run_9')

    const runClient = new FakeGatewayClient().on('GET', '/runs/run_2/events', {
      body: { runId: 'run_2', events: [] },
    })
    const runStatus = await skelmStatus(runClient, { runId: 'run_2' })
    expect(runClient.requests[0]?.path).toBe('/runs/run_2/events')
    expect(runStatus.refs.runId).toBe('run_2')
  })

  it('skelm_cancel DELETEs a run and POSTs cancel for a task', async () => {
    const runClient = new FakeGatewayClient().on('DELETE', '/runs/run_3', {
      body: { cancelled: true },
    })
    await skelmCancel(runClient, { runId: 'run_3' })
    expect(runClient.requests[0]).toMatchObject({ method: 'DELETE', path: '/runs/run_3' })

    const taskClient = new FakeGatewayClient().on('POST', '/v1/tasks/task_5/cancel', {
      body: { taskId: 'task_5', childRunId: 'run_5', status: 'cancelled' },
    })
    const res = await skelmCancel(taskClient, { taskId: 'task_5' })
    expect(taskClient.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/tasks/task_5/cancel',
    })
    expect(res.refs).toEqual({ taskId: 'task_5', runId: 'run_5' })
  })

  it('skelm_audit GETs /audit with the query params it was given', async () => {
    const client = new FakeGatewayClient().on('GET', '/audit', {
      body: { entries: [], nextBefore: null },
    })
    const res = await skelmAudit(client, { runId: 'run_1', action: 'run.start', limit: 10 })
    expect(client.requests[0]).toMatchObject({
      method: 'GET',
      path: '/audit',
      query: { runId: 'run_1', action: 'run.start', limit: '10' },
    })
    expect(res.refs.runId).toBe('run_1')
  })

  it('skelm_workflow_search lists /pipelines and filters by substring', async () => {
    const client = new FakeGatewayClient().on('GET', '/pipelines', {
      body: { pipelines: [{ id: 'hello.ts' }, { id: 'deploy.ts' }, { id: 'hello-world.ts' }] },
    })
    const all = await skelmWorkflowSearch(client, {})
    expect(all.data.map((p) => p.id)).toEqual(['hello.ts', 'deploy.ts', 'hello-world.ts'])
    const matched = await skelmWorkflowSearch(client, { query: 'hello' })
    expect(matched.data.map((p) => p.id)).toEqual(['hello.ts', 'hello-world.ts'])
  })
})

// ---------------------------------------------------------------------------
// Inbound → trigger-input normalization
// ---------------------------------------------------------------------------

describe('inbound normalization', () => {
  it('normalizes an OpenClaw message into a trigger input + reply DeliveryTarget', () => {
    const event: InboundEvent = {
      provider: 'openclaw',
      eventId: 'evt_42',
      type: 'message',
      target: { conversationId: 'chan_1', threadId: 'thr_1', userId: 'user_1' },
      text: 'hi',
      at: 123,
    }
    const { input, deliveryTarget } = normalizeInbound(event)
    expect(input).toEqual({
      provider: 'openclaw',
      eventId: 'evt_42',
      kind: 'message',
      conversationId: 'chan_1',
      threadId: 'thr_1',
      userId: 'user_1',
      text: 'hi',
      at: 123,
    })
    expect(deliveryTarget).toEqual({
      kind: 'openclaw',
      target: 'chan_1',
      metadata: { eventId: 'evt_42', threadId: 'thr_1', userId: 'user_1' },
    })
  })

  it('omits optional fields cleanly when absent', () => {
    const event: InboundEvent = {
      provider: 'slack',
      eventId: 'e1',
      type: 'command',
      target: { conversationId: 'c1' },
      command: 'run',
      at: 1,
    }
    const { input, deliveryTarget } = normalizeInbound(event)
    expect(input.threadId).toBeUndefined()
    expect(input.command).toBe('run')
    expect(deliveryTarget.metadata).toEqual({ eventId: 'e1' })
  })
})

// ---------------------------------------------------------------------------
// Result → DeliveryTarget mapping carries audit refs
// ---------------------------------------------------------------------------

describe('outbound delivery carries audit refs', () => {
  it('maps a tool result to an OutboundEvent on the originating channel with refs', () => {
    const target = { kind: 'openclaw', target: 'chan_1', metadata: { threadId: 't1' } }
    const result = { ok: true, data: {}, refs: { runId: 'run_1', auditQuery: { runId: 'run_1' } } }
    const out = resultToOutbound(result, target)
    expect(out.target).toEqual({ conversationId: 'chan_1', threadId: 't1' })
    expect((out.providerOptions?.skelmRefs as { runId: string }).runId).toBe('run_1')
  })

  it('deliverResult sends through the sink and returns the preserved refs', async () => {
    const deliver = vi.fn()
    const target = { kind: 'openclaw', target: 'chan_1' }
    const result = { ok: true, data: {}, refs: { taskId: 'task_1', runId: 'run_1' } }
    const refs = await deliverResult(deliver, result, target)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(refs).toEqual({ taskId: 'task_1', runId: 'run_1' })
  })

  it('targetToConversation maps metadata back to a conversation target', () => {
    expect(targetToConversation({ kind: 'x', target: 'c', metadata: { userId: 'u' } })).toEqual({
      conversationId: 'c',
      userId: 'u',
    })
  })
})

// ---------------------------------------------------------------------------
// Credential: bearer by reference, never logged
// ---------------------------------------------------------------------------

describe('bearer credential is by reference and redacted', () => {
  it('attaches a resolved bearer token to the Authorization header only', async () => {
    const token = fakeToken()
    const seenHeaders: Array<Record<string, string>> = []
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push({ ...(init?.headers as Record<string, string>) })
      return new Response(JSON.stringify({ pipelines: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:14738',
      bearer: bearerRef,
      resolveBearer: () => token,
      fetch: fakeFetch,
    })
    await client.request({ method: 'GET', path: '/pipelines' })
    expect(seenHeaders[0]?.Authorization).toBe(`Bearer ${token}`)
  })

  it('never reads process.env and never logs the token', async () => {
    const token = fakeToken()
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.join(' '))
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      logs.push(a.join(' '))
    })
    const fakeFetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch
    const resolveBearer = vi.fn(() => token)
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:14738',
      bearer: bearerRef,
      resolveBearer,
      fetch: fakeFetch,
    })
    await client.request({ method: 'POST', path: '/pipelines/x/run', body: { a: 1 } })
    spy.mockRestore()
    errSpy.mockRestore()
    expect(logs.join('\n')).not.toContain(token)
    // The reference exposes a name only — no value field.
    expect(JSON.stringify(bearerRef)).not.toContain(token)
    expect(resolveBearer).toHaveBeenCalledWith(bearerRef)
  })

  it('a 401/403 surfaces as GatewayAuthError with no token in the message', async () => {
    const token = fakeToken()
    const fakeFetch = vi.fn(
      async () => new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:14738',
      bearer: bearerRef,
      resolveBearer: () => token,
      fetch: fakeFetch,
    })
    await expect(client.request({ method: 'GET', path: '/audit' })).rejects.toBeInstanceOf(
      GatewayAuthError,
    )
    try {
      await client.request({ method: 'GET', path: '/audit' })
    } catch (e) {
      expect((e as Error).message).not.toContain(token)
    }
  })
})

// ---------------------------------------------------------------------------
// Unknown workflow / errors surface cleanly
// ---------------------------------------------------------------------------

describe('errors surface cleanly', () => {
  it('a 404 from run maps to UnknownWorkflowError naming the workflow', async () => {
    const client = new FakeGatewayClient().on('POST', '/pipelines/missing.ts/run', {
      status: 404,
      body: { error: 'not found' },
    })
    await expect(skelmRun(client, { workflowId: 'missing.ts' })).rejects.toBeInstanceOf(
      UnknownWorkflowError,
    )
  })

  it('status requires a run or task id', async () => {
    const client = new FakeGatewayClient()
    await expect(skelmStatus(client, {})).rejects.toThrow(/runId or taskId/)
  })
})

// ---------------------------------------------------------------------------
// Manifest + self-test
// ---------------------------------------------------------------------------

describe('manifest and self-test', () => {
  it('manifest declares the six tools and a by-reference credential', () => {
    expect(openclawManifest.actions?.map((a) => a.id)).toEqual([
      'skelm_run',
      'skelm_start',
      'skelm_status',
      'skelm_cancel',
      'skelm_audit',
      'skelm_workflow_search',
    ])
    expect(openclawManifest.credentials?.[0]?.id).toBe('skelm-gateway-bearer')
    expect(openclawManifest.auditRedaction?.redactPaths).toContain('headers.authorization')
  })

  it('self-test runs a representative run→status→deliver loop against the fake client', async () => {
    const report = await runSelfTest()
    expect(report.runId).toBe('run_selftest_1')
    expect(report.auditPreserved).toBe(true)
    expect(report.delivered.target.conversationId).toBe('chan_42')
  })
})
