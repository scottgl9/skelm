import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createAcpBackend } from '../src/acp/backend.js'
import { createAnthropicBackend } from '../src/anthropic/backend.js'
import { createOpenAIBackend } from '../src/openai/backend.js'
import { runBackendContract } from '../src/testing/contract.js'

const MOCK_ACP_AGENT = fileURLToPath(new URL('./acp/mock-acp-agent.ts', import.meta.url))

runBackendContract(
  async () => {
    const server = await startJsonServer(async (body) => {
      const request = body as { response_format?: { type?: string } }
      return request.response_format?.type === 'json_object'
        ? { choices: [{ message: { content: '{"greeting":"hello"}' } }] }
        : {
            choices: [{ message: { content: 'hello from openai contract' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }
    })

    const backend = createOpenAIBackend({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
    })

    return {
      ...backend,
      async dispose() {
        await server.close()
      },
    }
  },
  {
    name: 'openai',
    skip: ['agent', 'permission-gate'],
    inferCases: [
      {
        name: 'plain text infer',
        request: {
          messages: [{ role: 'user', content: 'say hi' }],
        },
      },
      {
        name: 'structured infer',
        request: {
          messages: [{ role: 'user', content: 'return json' }],
          outputSchema: z.object({ greeting: z.string() }),
        },
      },
    ],
  },
)

runBackendContract(
  async () => {
    const server = await startJsonServer(async (body) => {
      const request = body as {
        system?: string
        messages?: Array<{ content?: string }>
      }
      const structured =
        typeof request.system === 'string' && request.system.includes('Return only valid JSON')
      const agent = request.messages?.[0]?.content === 'contract agent'

      if (structured) {
        return {
          content: [{ type: 'text', text: '{"greeting":"hello"}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
        }
      }

      return {
        content: [{ type: 'text', text: agent ? 'anthropic agent ok' : 'anthropic infer ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }
    })

    const backend = createAnthropicBackend({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
    })

    return {
      ...backend,
      async dispose() {
        await server.close()
      },
    }
  },
  {
    name: 'anthropic',
    inferCases: [
      {
        name: 'plain infer',
        request: {
          messages: [{ role: 'user', content: 'say hi' }],
        },
      },
      {
        name: 'structured infer',
        request: {
          messages: [{ role: 'user', content: 'return json' }],
          outputSchema: z.object({ greeting: z.string() }),
        },
      },
    ],
    agentCases: [
      {
        name: 'plain agent run',
        request: {
          prompt: 'contract agent',
        },
      },
      {
        name: 'structured agent run',
        request: {
          prompt: 'contract agent structured',
          outputSchema: z.object({ greeting: z.string() }),
        },
      },
    ],
  },
)

// ACP backends are agent-only — `prompt: false` in their capabilities —
// so the `inference` half of the contract is structurally not applicable and
// is explicitly skipped (not silently). The remaining contract bullets
// (capability self-consistency, agent run shape, permission-gate fail-
// closed for `unsupported` toolPermissions) all run.
runBackendContract(
  () =>
    createAcpBackend({
      id: 'acp-contract',
      command: 'node',
      args: [MOCK_ACP_AGENT],
    }),
  {
    name: 'copilot-acp',
    skip: ['inference'],
    agentCases: [
      {
        name: 'basic agent run',
        request: {
          prompt: 'contract agent',
        },
      },
    ],
  },
)

async function startJsonServer(
  respond: (body: unknown) => Promise<unknown> | unknown,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }

    const raw = Buffer.concat(chunks).toString('utf8')
    const parsed = raw.length === 0 ? undefined : JSON.parse(raw)
    const body = await respond(parsed)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
