#!/usr/bin/env node

type Json = Record<string, unknown>

let buffer = ''

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id: number | string, result: Json): void {
  send({ jsonrpc: '2.0', id, result })
}

function handle(message: Json): void {
  const method = message.method as string | undefined
  const id = message.id as number | string | undefined
  if (method === 'notifications/initialized') {
    return
  }
  if (id === undefined) return
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mock-mcp', version: '0.1.0' },
    })
    return
  }
  if (method === 'tools/list') {
    reply(id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo text back',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
      ],
    })
    return
  }
  if (method === 'tools/call') {
    const params = message.params as { arguments?: { text?: string } } | undefined
    reply(id, {
      content: [
        {
          type: 'text',
          text: `echo:${params?.arguments?.text ?? ''}`,
        },
      ],
      isError: false,
    })
    return
  }
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  while (true) {
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline).replace(/\r$/, '').trim()
    buffer = buffer.slice(newline + 1)
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (Array.isArray(parsed)) {
        for (const msg of parsed) handle(msg as Json)
      } else {
        handle(parsed as Json)
      }
    } catch {
      // Ignore malformed input in the mock process.
    }
  }
})

process.stdin.on('end', () => process.exit(0))
