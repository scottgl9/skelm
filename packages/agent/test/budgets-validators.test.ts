import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePermissions } from '@skelm/core/permissions'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_METRICS_WARNING_CODE,
  AgentBudgetExceededError,
  AgentValidationError,
  ModelRegistry,
  type OutputValidator,
  type ToolValidator,
  createSkelmAgentBackend,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// OpenAI-compatible response builders + fetch queue
// ---------------------------------------------------------------------------

interface ToolCallStub {
  id?: string
  name: string
  arguments: Record<string, unknown>
}

interface TurnStub {
  content?: string
  toolCalls?: readonly ToolCallStub[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number }
}

function buildChatResponse(turn: TurnStub): unknown {
  const u = turn.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: turn.content ?? '',
          ...(turn.toolCalls && {
            tool_calls: turn.toolCalls.map((tc, i) => ({
              id: tc.id ?? `call_${i}`,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }),
        },
        finish_reason: turn.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { ...u, total_tokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens },
  }
}

function stubFetch(turns: readonly TurnStub[]): ReturnType<typeof vi.fn> {
  const queue = [...turns]
  const fetchSpy = vi.fn(async (): Promise<Response> => {
    const next = queue.shift() ?? turns[turns.length - 1]
    return new Response(JSON.stringify(buildChatResponse(next as TurnStub)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

function makeEventCtx(extra: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = []
  const ctx = {
    signal: new AbortController().signal,
    events: { publish: (ev: unknown) => events.push(ev as Record<string, unknown>) },
    runId: 'run-1',
    stepId: 'step-1',
    ...extra,
  }
  return { ctx, events }
}

function warnings(events: ReadonlyArray<Record<string, unknown>>) {
  return events.filter((e) => e.type === 'run.warning')
}

function makePolicy(overrides: Parameters<typeof resolvePermissions>[0] = {}) {
  return resolvePermissions(
    {
      allowedTools: ['*'],
      allowedExecutables: [],
      allowedSkills: [],
      allowedMcpServers: [],
      allowedSecrets: [],
      fsRead: [process.cwd()],
      fsWrite: [process.cwd()],
      networkEgress: 'deny',
      ...overrides,
    },
    undefined,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe('agent budgets', () => {
  it('tokenBudget: a run that exceeds it aborts with the right limit/observed + a preceding run.warning', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      // Force a multi-turn loop: each turn does a tool call (~15 tokens),
      // so the cumulative token count crosses 20 on the second turn.
      budget: { tokenBudget: 20 },
    })
    const dir = await mkdtemp(join(tmpdir(), 'skelm-budget-'))
    await writeFile(join(dir, 'a.txt'), 'data', 'utf8')
    try {
      const fetchSpy = stubFetch([
        { toolCalls: [{ id: 'c1', name: 'fs_read', arguments: { path: 'a.txt' } }] },
        { toolCalls: [{ id: 'c2', name: 'fs_read', arguments: { path: 'a.txt' } }] },
        { content: 'done' },
      ])
      const { ctx, events } = makeEventCtx()

      let caught: unknown
      try {
        await backend.run?.({ prompt: 'go', cwd: dir }, ctx)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AgentBudgetExceededError)
      const err = caught as AgentBudgetExceededError
      expect(err.dimension).toBe('tokens')
      expect(err.limit).toBe(20)
      expect(err.observed).toBeGreaterThan(20)
      const warn = warnings(events).find((w) => w.code === 'agent.budget.tokens')
      expect(warn).toBeDefined()
      // Aborted before all turns ran.
      expect(fetchSpy.mock.calls.length).toBeLessThan(3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('maxToolCalls: a run that exceeds it aborts with AgentBudgetExceededError', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      budget: { maxToolCalls: 1 },
    })
    const dir = await mkdtemp(join(tmpdir(), 'skelm-budget-tc-'))
    await writeFile(join(dir, 'a.txt'), 'data', 'utf8')
    try {
      stubFetch([
        {
          toolCalls: [
            { id: 'c1', name: 'fs_read', arguments: { path: 'a.txt' } },
            { id: 'c2', name: 'fs_read', arguments: { path: 'a.txt' } },
          ],
        },
        { content: 'done' },
      ])
      const { ctx, events } = makeEventCtx()

      await expect(backend.run?.({ prompt: 'go', cwd: dir }, ctx)).rejects.toMatchObject({
        name: 'AgentBudgetExceededError',
        dimension: 'toolCalls',
        limit: 1,
        observed: 2,
      })
      expect(warnings(events).some((w) => w.code === 'agent.budget.toolCalls')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('maxWallClockMs: an elapsed run aborts with the wallClock dimension', async () => {
    // Advance the clock between tracker construction and the elapsed check so
    // wall-clock elapsed deterministically exceeds the 5ms budget.
    let t = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => {
      const v = t
      t += 100
      return v
    })
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      budget: { maxWallClockMs: 5 },
    })
    stubFetch([{ content: 'hi' }])
    const { ctx, events } = makeEventCtx()

    await expect(backend.run?.({ prompt: 'go' }, ctx)).rejects.toMatchObject({
      name: 'AgentBudgetExceededError',
      dimension: 'wallClock',
      limit: 5,
    })
    expect(warnings(events).some((w) => w.code === 'agent.budget.wallClock')).toBe(true)
  })

  it('maxCostUsd: cost derived from the registry cost shape trips the budget', async () => {
    const registry = new ModelRegistry()
    registry.registerProvider('mock', {
      baseUrl: 'http://example.invalid',
      models: [
        {
          id: 'mock-model',
          api: 'openai-completions',
          input: ['text'],
          contextWindow: 8000,
          maxTokens: 1024,
          // $1 per 1K input, $2 per 1K output → one 10/5-token turn ≈ $0.02.
          cost: { input: 1, output: 2 },
          reasoning: false,
        },
      ],
    })
    const backend = createSkelmAgentBackend({
      registry,
      defaultModel: { provider: 'mock', id: 'mock-model' },
      budget: { maxCostUsd: 0.01 },
    })
    stubFetch([{ content: 'hi' }])
    const { ctx, events } = makeEventCtx()

    await expect(backend.run?.({ prompt: 'go' }, ctx)).rejects.toMatchObject({
      name: 'AgentBudgetExceededError',
      dimension: 'cost',
      limit: 0.01,
    })
    const warn = warnings(events).find((w) => w.code === 'agent.budget.cost')
    expect(warn).toBeDefined()
  })

  it('a run under budget completes normally', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      budget: { tokenBudget: 1000, maxToolCalls: 10, maxWallClockMs: 60_000, maxCostUsd: 100 },
    })
    stubFetch([{ content: 'all good' }])
    const { ctx } = makeEventCtx()

    const r = await backend.run?.({ prompt: 'go' }, ctx)
    expect(r?.text).toBe('all good')
    expect(r?.stopReason).toBe('stop')
  })
})

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

describe('agent validators', () => {
  it('failing soft output validator records a run.warning and the run continues', async () => {
    const softFail: OutputValidator = (text) =>
      text.includes('bad') ? { ok: false, reason: 'contains bad' } : { ok: true }
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      outputValidators: [softFail],
    })
    stubFetch([{ content: 'this is bad output' }])
    const { ctx, events } = makeEventCtx()

    const r = await backend.run?.({ prompt: 'go' }, ctx)
    expect(r?.text).toBe('this is bad output')
    const warn = warnings(events).find((w) => w.code === 'agent.validator.output')
    expect(warn?.message).toBe('contains bad')
  })

  it('failing hard output validator throws AgentValidationError', async () => {
    const hardFail: OutputValidator = () => ({
      ok: false,
      reason: 'always fails',
      severity: 'hard',
    })
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      outputValidators: [hardFail],
    })
    stubFetch([{ content: 'whatever' }])
    const { ctx, events } = makeEventCtx()

    await expect(backend.run?.({ prompt: 'go' }, ctx)).rejects.toMatchObject({
      name: 'AgentValidationError',
      stage: 'output',
      reason: 'always fails',
    })
    expect(warnings(events).some((w) => w.code === 'agent.validator.output')).toBe(true)
  })

  it('failing hard tool validator throws before the tool dispatches', async () => {
    const denyWrites: ToolValidator = ({ tool }) =>
      tool === 'fs_write' ? { ok: false, reason: 'no writes', severity: 'hard' } : { ok: true }
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      toolValidators: [denyWrites],
    })
    const dir = await mkdtemp(join(tmpdir(), 'skelm-toolval-'))
    try {
      stubFetch([
        {
          toolCalls: [
            { id: 'c1', name: 'fs_write', arguments: { path: join(dir, 'x.txt'), content: 'x' } },
          ],
        },
        { content: 'done' },
      ])
      const { ctx } = makeEventCtx({ permissions: makePolicy({ fsWrite: [dir], fsRead: [dir] }) })

      await expect(backend.run?.({ prompt: 'go', cwd: dir }, ctx)).rejects.toBeInstanceOf(
        AgentValidationError,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('output-schema mismatch surfaces a typed error via the runtime validate path', async () => {
    // The harness leaves outputSchema validation to the runtime, which calls
    // `validate(schema, result, 'output')` and throws SchemaValidationError.
    // Here we drive that validate() directly against the agent's text result
    // to prove the typed-error contract holds for a mismatch.
    const { SchemaValidationError, validate } = await import('@skelm/core')
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    stubFetch([{ content: 'not json' }])
    const { ctx } = makeEventCtx()
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) =>
          typeof value === 'object' && value !== null && 'n' in value
            ? { value }
            : { issues: [{ message: 'expected object with n' }] },
      },
    }
    const r = await backend.run?.({ prompt: 'go', outputSchema: schema }, ctx)
    await expect(validate(schema, r?.structured ?? r?.text, 'output')).rejects.toBeInstanceOf(
      SchemaValidationError,
    )
  })
})

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('agent metrics', () => {
  it('a completed run surfaces token/cost/latency numbers and a metrics warning', async () => {
    const registry = new ModelRegistry()
    registry.registerProvider('mock', {
      baseUrl: 'http://example.invalid',
      models: [
        {
          id: 'mock-model',
          api: 'openai-completions',
          input: ['text'],
          contextWindow: 8000,
          maxTokens: 1024,
          cost: { input: 1, output: 2 },
          reasoning: false,
        },
      ],
    })
    const backend = createSkelmAgentBackend({
      registry,
      defaultModel: { provider: 'mock', id: 'mock-model' },
    })
    const dir = await mkdtemp(join(tmpdir(), 'skelm-metrics-'))
    await writeFile(join(dir, 'a.txt'), 'data', 'utf8')
    try {
      stubFetch([
        { toolCalls: [{ id: 'c1', name: 'fs_read', arguments: { path: 'a.txt' } }] },
        { content: 'done' },
      ])
      const { ctx, events } = makeEventCtx()

      const r = await backend.run?.({ prompt: 'go', cwd: dir }, ctx)
      expect(r?.usage?.costUsd).toBeGreaterThan(0)
      // 2 turns × (10 input + 5 output) = 30 tokens.
      expect(r?.usage?.extras?.metricsTotalTokens).toBe(30)
      expect(r?.usage?.extras?.metricsToolCalls).toBe(1)
      expect(r?.usage?.extras?.metricsTurns).toBe(2)
      expect(typeof r?.usage?.extras?.metricsWallClockMs).toBe('number')

      const metricsWarn = warnings(events).find((w) => w.code === AGENT_METRICS_WARNING_CODE)
      expect(metricsWarn).toBeDefined()
      const payload = JSON.parse(metricsWarn?.message as string)
      expect(payload.tokens).toBe(30)
      expect(payload.toolCalls).toBe(1)
      expect(payload.turns).toBe(2)
      expect(payload.costUsd).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Regression: no budgets/validators behaves exactly as before
// ---------------------------------------------------------------------------

describe('agent budgets/validators regression', () => {
  it('streaming still works under a generous budget (deltas + final text intact)', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      budget: { tokenBudget: 1000, maxToolCalls: 10 },
    })
    const chunks = [
      { choices: [{ index: 0, delta: { content: 'Hel' } }] },
      { choices: [{ index: 0, delta: { content: 'lo' } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]
    const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
    const fetchSpy = vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const { ctx, events } = makeEventCtx()

    const r = await backend.run?.({ prompt: 'greet' }, ctx)
    expect(r?.text).toBe('Hello')
    const deltas = events.filter((e) => e.type === 'step.partial').map((e) => e.delta)
    expect(deltas).toEqual(['Hel', 'lo'])
    // Metrics still surface under streaming.
    expect(warnings(events).some((w) => w.code === AGENT_METRICS_WARNING_CODE)).toBe(true)
  })

  it('a run with no budgets/validators completes unchanged (metrics surfaced, behavior intact)', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    stubFetch([{ content: 'plain answer' }])
    // No event sink at all → no metrics warning, plain non-streaming path.
    const r = await backend.run?.({ prompt: 'go' }, { signal: new AbortController().signal })
    expect(r?.text).toBe('plain answer')
    expect(r?.stopReason).toBe('stop')
    // Usage still flows through; no pricing → no costUsd.
    expect(r?.usage?.inputTokens).toBe(10)
    expect(r?.usage?.costUsd).toBeUndefined()
  })
})
