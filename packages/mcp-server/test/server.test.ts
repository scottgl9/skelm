import { PassThrough } from 'node:stream'
import { code, pipeline } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MCP_SERVER_NAME, MCP_SERVER_VERSION, McpServer } from '../src/server.js'

describe('McpServer', () => {
  it('tools/list returns one tool per loaded pipeline', async () => {
    const wf = pipeline({
      id: 'review-pr',
      description: 'Review a pull request',
      input: z.object({ repo: z.string(), count: z.number().optional() }),
      steps: [code({ id: 'done', run: () => ({ ok: true }) })],
    })

    const responses = await runServer({ pipelines: [wf] }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ])

    expect(responses).toHaveLength(1)
    expect(responses[0]?.result).toEqual({
      tools: [
        {
          name: 'review-pr',
          description: 'Review a pull request',
          inputSchema: {
            type: 'object',
            properties: {
              repo: { type: 'string' },
              count: { type: 'number' },
            },
            required: ['repo'],
          },
        },
      ],
    })
  })

  it('tools/call runs the pipeline and returns JSON output', async () => {
    const wf = pipeline({
      id: 'echo',
      steps: [
        code({
          id: 'run',
          run: (ctx) => ({ echoed: ctx.input }),
        }),
      ],
    })

    const responses = await runServer({ pipelines: [wf] }, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { hello: 'world' } },
      },
    ])

    expect(responses[0]?.result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ echoed: { hello: 'world' } }) }],
    })
  })

  it('tools/call with an unknown tool name returns isError true', async () => {
    const responses = await runServer({ pipelines: [] }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'missing' } },
    ])

    expect(responses[0]?.result).toEqual({
      content: [{ type: 'text', text: 'unknown tool: missing' }],
      isError: true,
    })
  })

  it('tools/call returns isError true when the pipeline throws', async () => {
    const wf = pipeline({
      id: 'explode',
      steps: [
        code({
          id: 'run',
          run: () => {
            throw new Error('boom')
          },
        }),
      ],
    })

    const responses = await runServer({ pipelines: [wf] }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'explode' } },
    ])

    expect(responses[0]?.result).toEqual({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    })
  })

  it('initialize returns the expected server info', async () => {
    const responses = await runServer({ pipelines: [] }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
    ])

    expect(responses[0]?.result).toEqual({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    })
  })

  it('unknown methods return JSON-RPC -32601', async () => {
    const responses = await runServer({ pipelines: [] }, [
      { jsonrpc: '2.0', id: 1, method: 'nope' },
    ])

    expect(responses[0]?.error).toEqual({
      code: -32601,
      message: 'Method not found: nope',
    })
  })
})

async function runServer(
  options: { pipelines: readonly ReturnType<typeof pipeline>[] },
  requests: readonly Record<string, unknown>[],
): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => chunks.push(chunk))

  const server = new McpServer({
    workflows: [],
    projectRoot: process.cwd(),
    input,
    output,
    pipelines: options.pipelines,
  })

  const serving = server.serve()
  for (const request of requests) {
    input.write(`${JSON.stringify(request)}\n`)
  }
  input.end()
  await serving

  return chunks
    .join('')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
