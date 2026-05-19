import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { URL } from 'node:url'
import WebSocket from 'ws'
import type { TriggerSpec } from './types.js'

const DEFAULT_RECONNECT_DELAY_MS = 5_000
const DEFAULT_RSS_POLL_MS = 300_000
const MAX_RECONNECT_DELAY_MS = 60_000
const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
const SLACK_CONNECTIONS_OPEN_URL = 'https://slack.com/api/apps.connections.open'

type EventSourceSpec = Extract<TriggerSpec, { kind: 'event-source' }>

interface ParsedFeedItem {
  guid: string
  link?: string
  title?: string
  pubDate?: string
  description?: string
}

interface DiscordGatewayMessage {
  op?: number
  t?: string | null
  s?: number | null
  d?: unknown
}

interface SlackSocketModeMessage {
  type?: string
  envelope_id?: string
  payload?: {
    type?: string
    event?: {
      type?: string
    }
  }
  reason?: string
  debug_info?: unknown
}

export class EventSourceManager {
  private abortController = new AbortController()
  private reconnectTimer: NodeJS.Timeout | null = null
  private ws: WebSocket | null = null
  private sseRequest: ReturnType<typeof httpGet> | null = null
  private sseResponse: import('node:http').IncomingMessage | null = null
  private rssTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private seenGuids = new Set<string>()
  private lastEventId: string | undefined
  private started = false
  private firstRssPoll = true
  private discordSequence: number | null = null

  constructor(
    private spec: EventSourceSpec,
    private onFire: (payload: unknown) => void,
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    switch (this.spec.source) {
      case 'websocket':
        this.startWebSocket()
        break
      case 'sse':
        this.startSse()
        break
      case 'rss':
        this.startRss()
        break
      case 'discord':
        this.startDiscord()
        break
      case 'slack':
        this.startSlack()
        break
      case 'custom': {
        const start = this.spec.options.start
        if (start !== undefined) {
          const result = start((payload) => this.fire(payload), this.abortController.signal)
          if (result instanceof Promise) void result.catch(() => {})
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
    this.discordSequence = null
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
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
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
      let buffer = ''
      let dataLines: string[] = []
      let eventField: string | undefined
      let idField: string | undefined

      const flushEvent = () => {
        if (dataLines.length === 0) {
          eventField = undefined
          idField = undefined
          return
        }
        const data = dataLines.join('\n')
        if (idField !== undefined) this.lastEventId = idField
        this.fire({
          data: parseMaybeJson(data),
          event: eventField ?? 'message',
          ...(idField !== undefined && { id: idField }),
          source: 'sse',
          url,
          receivedAt: new Date().toISOString(),
        })
        dataLines = []
        eventField = undefined
        idField = undefined
      }

      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line === '') {
            flushEvent()
            continue
          }
          if (line.startsWith(':')) continue
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          else if (line.startsWith('event:')) eventField = line.slice(6).trimStart()
          else if (line.startsWith('id:')) idField = line.slice(3).trimStart()
        }
      })
      res.on('end', () => {
        flushEvent()
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

  private startDiscord(attempt = 0): void {
    const { token, intents } = this.spec.options
    if (typeof token !== 'string' || token.length === 0) return
    if (typeof intents !== 'number') return

    const ws = new WebSocket(DISCORD_GATEWAY_URL)
    this.ws = ws
    let reconnectScheduled = false
    const scheduleReconnect = () => {
      if (reconnectScheduled) return
      reconnectScheduled = true
      this.stopHeartbeat()
      this.scheduleReconnect(attempt, (nextAttempt) => this.startDiscord(nextAttempt))
    }

    ws.on('open', () => {
      reconnectScheduled = false
      this.discordSequence = null
    })
    ws.on('message', (data: WebSocket.RawData) => {
      const payload = parseMaybeJson(stringifySocketData(data))
      if (!isDiscordGatewayMessage(payload)) return
      if (typeof payload.s === 'number') this.discordSequence = payload.s
      switch (payload.op) {
        case 10: {
          const heartbeatInterval = readHeartbeatInterval(payload.d)
          if (heartbeatInterval !== null) this.startDiscordHeartbeat(ws, heartbeatInterval)
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token,
                intents,
                properties: {
                  os: process.platform,
                  browser: 'skelm',
                  device: 'skelm',
                },
              },
            }),
          )
          break
        }
        case 0:
          if (payload.t === null || payload.t === undefined) return
          if (!matchesEventName(payload.t, this.spec.options.events)) return
          this.fire({ t: payload.t, d: payload.d })
          break
        case 7:
        case 9:
          scheduleReconnect()
          ws.close()
          break
        default:
          break
      }
    })
    ws.on('error', () => {
      scheduleReconnect()
    })
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null
      this.stopHeartbeat()
      scheduleReconnect()
    })
  }

  private startDiscordHeartbeat(ws: WebSocket, intervalMs: number): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ op: 1, d: this.discordSequence }))
    }, intervalMs)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private startSlack(attempt = 0): void {
    const { appToken } = this.spec.options
    if (typeof appToken !== 'string' || appToken.length === 0) return
    let reconnectScheduled = false
    const scheduleReconnect = () => {
      if (reconnectScheduled) return
      reconnectScheduled = true
      this.scheduleReconnect(attempt, (nextAttempt) => this.startSlack(nextAttempt))
    }

    void openSlackSocketUrl(appToken)
      .then((url) => {
        if (url === null || this.abortController.signal.aborted) {
          scheduleReconnect()
          return
        }
        const ws = new WebSocket(url)
        this.ws = ws
        ws.on('open', () => {
          reconnectScheduled = false
        })
        ws.on('message', (data: WebSocket.RawData) => {
          const payload = parseMaybeJson(stringifySocketData(data))
          if (!isSlackSocketModeMessage(payload)) return
          if (typeof payload.envelope_id === 'string') {
            ws.send(JSON.stringify({ envelope_id: payload.envelope_id }))
          }
          if (payload.type === 'disconnect') {
            scheduleReconnect()
            ws.close()
            return
          }
          if (payload.type === 'hello') return
          const eventName = slackEventName(payload)
          if (eventName === undefined) return
          if (!matchesEventName(eventName, this.spec.options.events)) return
          this.fire(payload)
        })
        ws.on('error', () => {
          scheduleReconnect()
        })
        ws.on('close', () => {
          if (this.ws === ws) this.ws = null
          scheduleReconnect()
        })
      })
      .catch(() => {
        scheduleReconnect()
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

function matchesEventName(name: string, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined || allowed.length === 0) return true
  return allowed.includes(name)
}

function isDiscordGatewayMessage(value: unknown): value is DiscordGatewayMessage {
  return typeof value === 'object' && value !== null
}

function readHeartbeatInterval(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null
  const heartbeatInterval = (value as { heartbeat_interval?: unknown }).heartbeat_interval
  return typeof heartbeatInterval === 'number' ? heartbeatInterval : null
}

function isSlackSocketModeMessage(value: unknown): value is SlackSocketModeMessage {
  return typeof value === 'object' && value !== null
}

function slackEventName(payload: SlackSocketModeMessage): string | undefined {
  if (payload.type === 'events_api') return payload.payload?.event?.type
  return payload.type
}

async function openSlackSocketUrl(appToken: string): Promise<string | null> {
  return await new Promise((resolve) => {
    const req = httpsGet(
      SLACK_CONNECTIONS_OPEN_URL,
      {
        headers: {
          Authorization: `Bearer ${appToken}`,
        },
      },
      (res) => {
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
        res.on('end', () => {
          const parsed = parseMaybeJson(body)
          if (typeof parsed !== 'object' || parsed === null) {
            resolve(null)
            return
          }
          const url = (parsed as { url?: unknown }).url
          resolve(typeof url === 'string' ? url : null)
        })
        res.on('error', () => resolve(null))
      },
    )
    req.on('error', () => resolve(null))
  })
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
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
  return blocks
    .map((match) => parseFeedItemBlock(match[2] ?? ''))
    .filter((item): item is ParsedFeedItem => item !== null)
}

function parseFeedItemBlock(block: string): ParsedFeedItem | null {
  const guid =
    firstXmlValue(block, ['guid', 'id']) ??
    firstXmlAttr(block, 'link', 'href') ??
    firstXmlValue(block, ['link'])
  if (guid === undefined) return null
  const link = firstXmlAttr(block, 'link', 'href') ?? firstXmlValue(block, ['link'])
  const title = firstXmlValue(block, ['title'])
  const pubDate = firstXmlValue(block, ['pubDate', 'updated'])
  const description = firstXmlValue(block, ['description', 'summary'])
  return {
    guid,
    ...(link !== undefined && { link }),
    ...(title !== undefined && { title }),
    ...(pubDate !== undefined && { pubDate }),
    ...(description !== undefined && { description }),
  }
}

function firstXmlValue(block: string, tags: string[]): string | undefined {
  for (const tag of tags) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)
    const value = match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
    if (value) return value
  }
  return undefined
}

function firstXmlAttr(block: string, tag: string, attr: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]+)"[^>]*>`, 'i').exec(block)
  return match?.[1]?.trim() || undefined
}

function compareFeedItemsDesc(a: ParsedFeedItem, b: ParsedFeedItem): number {
  const aTime = a.pubDate !== undefined ? Date.parse(a.pubDate) : Number.NaN
  const bTime = b.pubDate !== undefined ? Date.parse(b.pubDate) : Number.NaN
  if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0
  if (Number.isNaN(aTime)) return 1
  if (Number.isNaN(bTime)) return -1
  return bTime - aTime
}
