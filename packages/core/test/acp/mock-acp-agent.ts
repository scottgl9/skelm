#!/usr/bin/env node
// Mock ACP agent used for unit tests of @skelm/core/acp.
//
// Speaks just enough of the protocol to be useful: initialize → respond,
// session/new → respond, session/prompt → emit two streaming
// agent_message_chunk notifications, then return stopReason='end_turn'.

import { Buffer } from 'node:buffer'

type Json = Record<string, unknown>

let buffer = Buffer.alloc(0)

function send(message: Json): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function reply(id: number | string, result: Json): void {
  send({ jsonrpc: '2.0', id, result })
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
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.slice(0, headerEnd).toString('ascii')
    const m = /Content-Length:\s*(\d+)/i.exec(header)
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
  }
})

process.stdin.on('end', () => process.exit(0))
