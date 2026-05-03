#!/usr/bin/env node
// Mock ACP agent used for unit tests of @skelm/core/acp.
//
// Speaks just enough of the protocol to be useful: initialize → respond,
// session/new → respond, session/prompt → emit two streaming
// agent_message_chunk notifications, then return stopReason='end_turn'.
// Accepts either JSONL or Content-Length input so tests can exercise both.

import { Buffer } from 'node:buffer'

type Json = Record<string, unknown>

let buffer = Buffer.alloc(0)
const outputMode = process.env.SKELM_ACP_MOCK_OUTPUT ?? 'content-length'

function send(message: Json): void {
  const payload = JSON.stringify(message)
  if (outputMode === 'jsonl') {
    process.stdout.write(`${payload}\n`)
    return
  }
  const body = Buffer.from(payload, 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function reply(id: number | string, result: Json): void {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id: number | string, code: number, message: string, data?: Json): void {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data && { data }) } })
}

function notify(method: string, params: Json): void {
  send({ jsonrpc: '2.0', method, params })
}

let nextSessionId = 1

function handle(message: Json): void {
  const method = message.method as string | undefined
  const id = message.id as number | string | undefined
  if (id === undefined) return // ignore notifications
  if (method === 'initialize') {
    reply(id, { protocolVersion: 1, agentCapabilities: {} })
    return
  }
  if (method === 'session/new') {
    const params = message.params as { mcpServers?: unknown } | undefined
    if (!Array.isArray(params?.mcpServers)) {
      replyError(id, -32602, 'Invalid params', { mcpServers: 'expected array' })
      return
    }
    for (const server of params.mcpServers) {
      if (typeof server !== 'object' || server === null) {
        replyError(id, -32602, 'Invalid params', { mcpServers: 'expected object entries' })
        return
      }
      const record = server as Record<string, unknown>
      if (typeof record.name !== 'string' || typeof record.type !== 'string') {
        replyError(id, -32602, 'Invalid params', { mcpServers: 'expected name/type strings' })
        return
      }
      if (record.type === 'stdio') {
        if (typeof record.command !== 'string') {
          replyError(id, -32602, 'Invalid params', { mcpServers: 'stdio requires command' })
          return
        }
      } else if (record.type === 'http' || record.type === 'sse') {
        if (typeof record.url !== 'string') {
          replyError(id, -32602, 'Invalid params', { mcpServers: `${record.type} requires url` })
          return
        }
      } else {
        replyError(id, -32602, 'Invalid params', {
          mcpServers: `unsupported type: ${String(record.type)}`,
        })
        return
      }
    }
    const sid = `session-${nextSessionId++}`
    reply(id, { sessionId: sid })
    return
  }
  if (method === 'session/prompt') {
    const params = message.params as {
      sessionId: string
      prompt: { type: string; text?: string }[]
    }
    const userText = params.prompt.find((b) => b.type === 'text')?.text ?? ''
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'echo:' },
      },
    })
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: userText },
      },
    })
    reply(id, { stopReason: 'end_turn' })
    return
  }
  reply(id, {})
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    while (buffer.length > 0 && (buffer[0] === 0x0a || buffer[0] === 0x0d)) {
      buffer = buffer.slice(1)
    }
    if (buffer.length === 0) return
    if (startsWithContentLengthHeader()) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = buffer.slice(0, headerEnd).toString('ascii')
      const m = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
      if (!m || !m[1]) return
      const length = Number.parseInt(m[1], 10)
      const start = headerEnd + 4
      if (buffer.length < start + length) return
      const body = buffer.slice(start, start + length).toString('utf8')
      buffer = buffer.slice(start + length)
      try {
        handle(JSON.parse(body) as Json)
      } catch {
        // ignore parse errors for the mock
      }
      continue
    }
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline).toString('utf8').replace(/\r$/, '').trim()
    buffer = buffer.slice(newline + 1)
    if (line.length === 0) continue
    try {
      handle(JSON.parse(line) as Json)
    } catch {
      // ignore parse errors for the mock
    }
  }
})

process.stdin.on('end', () => process.exit(0))

function startsWithContentLengthHeader(): boolean {
  const prefix = buffer.subarray(0, Math.min(buffer.length, 32)).toString('ascii')
  return /^content-length:/i.test(prefix)
}
