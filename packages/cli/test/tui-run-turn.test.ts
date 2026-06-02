import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runTurn } from '../src/tui.js'

// Exercises the SSE follow loop in runTurn against a mocked fetch / event
// stream so we can prove the failure surfacing without standing up a gateway.

const SUBMIT_URL = 'http://gw/v1/chat/tui/submit'
const STREAM_URL = 'http://gw/runs/r1/stream'
const STATE_URL = 'http://gw/runs/r1'

const stubIo = () => ({
  stdin: process.stdin,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
})

const sseBody = (
  frames: ReadonlyArray<{ event: string; data: unknown }>,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  const chunks = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
  return new ReadableStream({
    start(controller): void {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
}

const client = {
  discovery: { url: 'http://gw' },
  headers: {},
}

interface FetchResponse {
  ok: boolean
  status: number
  statusText: string
  body: ReadableStream<Uint8Array> | null
  json: () => Promise<unknown>
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const okJson = (json: unknown): FetchResponse => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  body: null,
  json: async () => json,
})

const okStream = (frames: ReadonlyArray<{ event: string; data: unknown }>): FetchResponse => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  body: sseBody(frames),
  json: async () => ({}),
})

describe('runTurn', () => {
  it('returns the run.completed reply text', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === SUBMIT_URL) return okJson({ runId: 'r1' })
      if (url === STREAM_URL) {
        return okStream([
          { event: 'step.partial', data: { type: 'step.partial', delta: 'hel' } },
          { event: 'step.partial', data: { type: 'step.partial', delta: 'lo' } },
          { event: 'run.completed', data: { type: 'run.completed', output: { reply: 'hello' } } },
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const partials: string[] = []
    const reply = await runTurn('tui', 'sess', 'hi', client, stubIo(), (p) => partials.push(p))
    expect(reply).toBe('hello')
    expect(partials).toEqual(['hel', 'hello'])
  })

  it('surfaces a failure message from run.failed instead of returning empty', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === SUBMIT_URL) return okJson({ runId: 'r1' })
      if (url === STREAM_URL) {
        return okStream([
          {
            event: 'run.failed',
            data: {
              type: 'run.failed',
              error: { name: 'PermissionDeniedError', message: 'egress denied' },
            },
          },
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const reply = await runTurn('tui', 'sess', 'hi', client, stubIo())
    expect(reply).toBe('(failed) egress denied')
  })

  it('falls back to fetching the run record when the stream missed the error', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === SUBMIT_URL) return okJson({ runId: 'r1' })
      if (url === STREAM_URL) return okStream([]) // no terminal event
      if (url === STATE_URL) return okJson({ status: 'failed', error: { message: 'boom' } })
      throw new Error(`unexpected fetch ${url}`)
    })
    const reply = await runTurn('tui', 'sess', 'hi', client, stubIo())
    expect(reply).toBe('(failed) boom')
  })

  it('surfaces a submit-time gateway error rather than rendering blank', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === SUBMIT_URL)
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          body: null,
          json: async () => ({}),
        } satisfies FetchResponse
      throw new Error(`unexpected fetch ${url}`)
    })
    const reply = await runTurn('tui', 'sess', 'hi', client, stubIo())
    expect(reply).toMatch(/submit failed.*503/)
  })
})
