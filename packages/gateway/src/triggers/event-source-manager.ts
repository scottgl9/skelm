import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { URL } from 'node:url'
import { parseFeed } from '@rowanmanning/feed-parser'
import { createParser } from 'eventsource-parser'
import WebSocket from 'ws'
import type { TriggerSpec } from './types.js'

const DEFAULT_RECONNECT_DELAY_MS = 5_000
const DEFAULT_RSS_POLL_MS = 300_000
const MAX_RECONNECT_DELAY_MS = 60_000

type EventSourceSpec = Extract<TriggerSpec, { kind: 'event-source' }>

interface ParsedFeedItem {
  guid: string
  link?: string
  title?: string
  pubDate?: string
  description?: string
}

/**
 * Generic event-source adapter. Each instance owns a single connection
 * (WebSocket, SSE, RSS poll loop, or caller-supplied callback) and dispatches
 * fires into the coordinator. Provider-specific sockets (Slack socket mode,
 * Discord gateway) live in `@skelm/integrations` so credential handling and
 * conversion stay alongside the rest of that vendor's integration code.
 */
export class EventSourceManager {
  private abortController = new AbortController()
  private reconnectTimer: NodeJS.Timeout | null = null
  private ws: WebSocket | null = null
  private sseRequest: ReturnType<typeof httpGet> | null = null
  private sseResponse: import('node:http').IncomingMessage | null = null
  private rssTimer: NodeJS.Timeout | null = null
  private seenGuids = new Set<string>()
  private lastEventId: string | undefined
  private started = false
  private firstRssPoll = true

  constructor(
    private spec: EventSourceSpec,
    private onFire: (payload: unknown) => void,
    private onError?: (err: Error) => void,
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    switch (this.spec.source) {
      case 'websocket':
        if (this.spec.options.url === undefined) {
          throw new Error(`event-source source: 'websocket' requires options.url`)
        }
        this.startWebSocket()
        break
      case 'sse':
        if (this.spec.options.url === undefined) {
          throw new Error(`event-source source: 'sse' requires options.url`)
        }
        this.startSse()
        break
      case 'rss':
        if (this.spec.options.feedUrl === undefined) {
          throw new Error(`event-source source: 'rss' requires options.feedUrl`)
        }
        this.startRss()
        break
      case 'custom': {
        const start = this.spec.options.start
        if (start === undefined) {
          throw new Error(`event-source source: 'custom' requires options.start`)
        }
        const result = start((payload) => this.fire(payload), this.abortController.signal)
        // Async throws used to be silently swallowed; surface them so the
        // coordinator can populate reg.lastError (issue #163).
        if (result instanceof Promise) {
          void result.catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            this.onError?.(e)
          })
        }
        break
      }
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.abortController.abort()
    this.clearTimers()
    this.ws?.close()
    this.ws = null
    this.sseRequest?.destroy()
    this.sseRequest = null
    this.sseResponse?.destroy()
    this.sseResponse = null
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.rssTimer !== null) {
      clearInterval(this.rssTimer)
      this.rssTimer = null
    }
  }

  private fire(payload: unknown): void {
    if (!matchesFilter(payload, this.spec.filter)) return
    this.onFire(payload)
  }

  private scheduleReconnect(attempt: number, restart: (nextAttempt: number) => void): void {
    if (this.abortController.signal.aborted) return
    if (this.spec.options.reconnect === false) return
    const maxAttempts = this.spec.options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY
    if (attempt >= maxAttempts) return
    const baseDelay = this.spec.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    const delay = Math.min(baseDelay * 2 ** attempt, MAX_RECONNECT_DELAY_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      restart(attempt + 1)
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private startWebSocket(attempt = 0): void {
    const { url } = this.spec.options
    if (url === undefined) return
    const ws = new WebSocket(url)
    this.ws = ws
    let reconnectScheduled = false
    const scheduleReconnect = () => {
      if (reconnectScheduled) return
      reconnectScheduled = true
      this.scheduleReconnect(attempt, (nextAttempt) => this.startWebSocket(nextAttempt))
    }

    ws.on('open', () => {
      reconnectScheduled = false
    })
    ws.on('message', (data: WebSocket.RawData) => {
      const text = stringifySocketData(data)
      this.fire({
        data: parseMaybeJson(text),
        source: 'websocket',
        url,
        receivedAt: new Date().toISOString(),
      })
    })
    ws.on('error', () => {
      scheduleReconnect()
    })
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null
      scheduleReconnect()
    })
  }

  private startSse(attempt = 0): void {
    const { url } = this.spec.options
    if (url === undefined) return
    const target = new URL(url)
    const get = target.protocol === 'https:' ? httpsGet : httpGet
    let reconnectScheduled = false
    const headers: Record<string, string> = {}
    if (this.lastEventId !== undefined) headers['Last-Event-ID'] = this.lastEventId

    const scheduleReconnect = () => {
      if (reconnectScheduled) return
      reconnectScheduled = true
      this.scheduleReconnect(attempt, (nextAttempt) => this.startSse(nextAttempt))
    }

    const req = get(url, { headers }, (res) => {
      this.sseResponse = res
      if ((res.statusCode ?? 200) >= 400) {
        res.resume()
        scheduleReconnect()
        return
      }
      reconnectScheduled = false
      const parser = createParser({
        maxBufferSize: 1_000_000,
        onEvent: (message) => {
          if (message.id !== undefined) this.lastEventId = message.id
          const id = message.id
          this.fire({
            data: parseMaybeJson(message.data),
            event: message.event ?? 'message',
            ...(id !== undefined && { id }),
            source: 'sse',
            url,
            receivedAt: new Date().toISOString(),
          })
        },
      })

      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        parser.feed(chunk)
      })
      res.on('end', () => {
        parser.reset({ consume: true })
        scheduleReconnect()
      })
      res.on('error', () => {
        scheduleReconnect()
      })
    })

    req.on('error', () => {
      scheduleReconnect()
    })
    this.sseRequest = req
  }

  private startRss(): void {
    const poll = async () => {
      const xml = await fetchText(this.spec.options.feedUrl)
      if (xml === null) return
      const items = parseFeedItems(xml)
      const initialItems = this.spec.options.initialItems ?? 0

      if (this.firstRssPoll) {
        this.firstRssPoll = false
        const sorted = [...items].sort(compareFeedItemsDesc)
        const allowedInitial = new Set(
          sorted.slice(0, Math.max(0, initialItems)).map((item) => item.guid),
        )
        for (const item of items) {
          this.seenGuids.add(item.guid)
          if (allowedInitial.has(item.guid)) this.fireRssItem(item)
        }
        return
      }

      for (const item of items) {
        if (this.seenGuids.has(item.guid)) continue
        this.seenGuids.add(item.guid)
        this.fireRssItem(item)
      }
    }

    void poll()
    const pollIntervalMs = this.spec.options.pollIntervalMs ?? DEFAULT_RSS_POLL_MS
    this.rssTimer = setInterval(() => {
      void poll()
    }, pollIntervalMs)
    this.rssTimer.unref?.()
  }

  private fireRssItem(item: ParsedFeedItem): void {
    this.fire({
      guid: item.guid,
      ...(item.link !== undefined && { link: item.link }),
      ...(item.title !== undefined && { title: item.title }),
      ...(item.pubDate !== undefined && { pubDate: item.pubDate }),
      ...(item.description !== undefined && { description: item.description }),
      source: 'rss',
      feedUrl: this.spec.options.feedUrl,
      receivedAt: new Date().toISOString(),
    })
  }
}

function matchesFilter(payload: unknown, filter: Record<string, unknown> | undefined): boolean {
  if (filter === undefined) return true
  if (payload === null || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  return Object.entries(filter).every(([key, value]) => record[key] === value)
}

function stringifySocketData(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data))
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function fetchText(url: string | undefined): Promise<string | null> {
  if (url === undefined) return null
  const target = new URL(url)
  const get = target.protocol === 'https:' ? httpsGet : httpGet
  return await new Promise((resolve) => {
    const req = get(url, (res) => {
      if ((res.statusCode ?? 200) >= 400) {
        res.resume()
        resolve(null)
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve(body))
      res.on('error', () => resolve(null))
    })
    req.on('error', () => resolve(null))
  })
}

function parseFeedItems(xml: string): ParsedFeedItem[] {
  try {
    return parseFeed(xml)
      .items.map((item) => {
        const guid = item.id ?? item.url
        if (guid === null) return null
        const pubDate = item.published ?? item.updated
        return {
          guid,
          ...(item.url !== null && { link: item.url }),
          ...(item.title !== null && { title: item.title }),
          ...(pubDate !== null && { pubDate: pubDate.toISOString() }),
          ...(item.description !== null && { description: item.description }),
        }
      })
      .filter((item): item is ParsedFeedItem => item !== null)
  } catch {
    return []
  }
}

function compareFeedItemsDesc(a: ParsedFeedItem, b: ParsedFeedItem): number {
  const aTime = a.pubDate !== undefined ? Date.parse(a.pubDate) : Number.NaN
  const bTime = b.pubDate !== undefined ? Date.parse(b.pubDate) : Number.NaN
  if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0
  if (Number.isNaN(aTime)) return 1
  if (Number.isNaN(bTime)) return -1
  return bTime - aTime
}
