import { type Server, createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { TriggerCoordinator } from '../src/triggers/coordinator.js'
import { pickFreePort } from './utils/pick-free-port.js'

describe('event-source triggers', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop()
      await fn?.()
    }
  })

  it('fires on WebSocket messages', async () => {
    const port = await pickFreePort()
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    cleanup.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))

    const payloads: unknown[] = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => void payloads.push(ctx.payload),
    })
    cleanup.push(() => coordinator.stop())

    coordinator.register({
      kind: 'event-source',
      id: 'ws-trigger',
      workflowId: 'wf',
      source: 'websocket',
      options: { url: `ws://127.0.0.1:${port}` },
    })

    await waitFor(() => wss.clients.size === 1)
    const client = Array.from(wss.clients)[0]
    client?.send(JSON.stringify({ hello: 'ws' }))

    await waitFor(() => payloads.length === 1)
    expect(payloads[0]).toMatchObject({
      data: { hello: 'ws' },
      source: 'websocket',
      url: `ws://127.0.0.1:${port}`,
    })
  })

  it('fires on SSE events', async () => {
    const port = await pickFreePort()
    const responses = new Set<import('node:http').ServerResponse>()
    const server = createServer((req, res) => {
      if (req.url !== '/events') {
        res.statusCode = 404
        res.end()
        return
      }
      responses.add(res)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      })
      res.write('id: evt-1\n')
      res.write('event: notice\n')
      res.write('data: {"hello":"sse"}\n\n')
    })
    await listen(server, port)
    cleanup.push(() => closeServer(server))
    cleanup.push(() => {
      for (const res of responses) res.destroy()
    })

    const payloads: unknown[] = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => void payloads.push(ctx.payload),
    })
    cleanup.push(() => coordinator.stop())

    coordinator.register({
      kind: 'event-source',
      id: 'sse-trigger',
      workflowId: 'wf',
      source: 'sse',
      options: { url: `http://127.0.0.1:${port}/events`, reconnect: false },
    })

    await waitFor(() => payloads.length === 1)
    expect(payloads[0]).toMatchObject({
      data: { hello: 'sse' },
      event: 'notice',
      id: 'evt-1',
      source: 'sse',
      url: `http://127.0.0.1:${port}/events`,
    })
  })

  it('fires for new RSS items on the second poll when initialItems=0', async () => {
    const port = await pickFreePort()
    let xml = rssFeed([{ guid: '1', title: 'First', pubDate: '2026-05-18T00:00:00.000Z' }])
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
      res.end(xml)
    })
    await listen(server, port)
    cleanup.push(() => closeServer(server))

    const payloads: unknown[] = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => void payloads.push(ctx.payload),
    })
    cleanup.push(() => coordinator.stop())

    coordinator.register({
      kind: 'event-source',
      id: 'rss-trigger',
      workflowId: 'wf',
      source: 'rss',
      options: {
        feedUrl: `http://127.0.0.1:${port}/feed.xml`,
        pollIntervalMs: 25,
        initialItems: 0,
      },
    })

    await delay(50)
    expect(payloads).toHaveLength(0)

    xml = rssFeed([
      { guid: '2', title: 'Second', pubDate: '2026-05-19T00:00:00.000Z' },
      { guid: '1', title: 'First', pubDate: '2026-05-18T00:00:00.000Z' },
    ])

    await waitFor(() => payloads.length === 1)
    expect(payloads[0]).toMatchObject({
      guid: '2',
      title: 'Second',
      source: 'rss',
      feedUrl: `http://127.0.0.1:${port}/feed.xml`,
    })
  })

  it('fires for custom sources', async () => {
    const payloads: unknown[] = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => void payloads.push(ctx.payload),
    })
    cleanup.push(() => coordinator.stop())

    coordinator.register({
      kind: 'event-source',
      id: 'custom-trigger',
      workflowId: 'wf',
      source: 'custom',
      options: {
        start: (fire) => {
          fire({ hello: 'custom' })
        },
      },
    })

    await waitFor(() => payloads.length === 1)
    expect(payloads).toEqual([{ hello: 'custom' }])
  })

  it('stops delivering after coordinator.stop()', async () => {
    const port = await pickFreePort()
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    cleanup.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))

    const payloads: unknown[] = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => void payloads.push(ctx.payload),
    })

    coordinator.register({
      kind: 'event-source',
      id: 'ws-stop-trigger',
      workflowId: 'wf',
      source: 'websocket',
      options: { url: `ws://127.0.0.1:${port}`, reconnect: false },
    })

    await waitFor(() => wss.clients.size === 1)
    const client = Array.from(wss.clients)[0]
    client?.send('before-stop')
    await waitFor(() => payloads.length === 1)

    await coordinator.stop()
    client?.send('after-stop')
    await delay(50)
    expect(payloads).toHaveLength(1)
  })
})

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('timed out waiting for condition')
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function rssFeed(items: Array<{ guid: string; title: string; pubDate: string }>): string {
  const body = items
    .map(
      (item) =>
        `<item><guid>${item.guid}</guid><title>${item.title}</title><pubDate>${item.pubDate}</pubDate><description>${item.title}</description></item>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${body}</channel></rss>`
}
