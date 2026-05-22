/**
 * Telegram Coding Agent (UC1) Pipeline Fixture
 *
 * This fixture demonstrates:
 * - Persistent workspace usage for a coding agent
 * - Idempotent message handling (same message = no-op)
 * - MCP integration with mocked Telegram
 * - State-based deduplication across runs
 *
 * Usage in tests:
 * ```ts
 * const { pipeline } = await import('./telegram-coding-agent.pipeline.js')
 * const run = await runPipeline(pipeline, { message: 'hello' })
 * ```
 */

import { z } from 'zod'
import { agent, code, idempotent, pipeline } from '../../../src/builders.js'
import type { Pipeline } from '../../../src/types.js'

// Input schema for triggering the pipeline
export const TelegramInputSchema = z.object({
  messageId: z.number().describe('Unique Telegram message ID for idempotency'),
  chatId: z.string().describe('Telegram chat ID'),
  from: z.string().describe('Sender username'),
  text: z.string().describe('Message text content'),
})

export type TelegramInput = z.infer<typeof TelegramInputSchema>

// Output schema
export const TelegramAgentOutputSchema = z.object({
  handled: z.boolean().describe('Whether the message was processed'),
  reason: z.string().describe("Why it was/wasn't handled"),
  response: z.string().optional().describe('Response message if handled'),
})

export type TelegramAgentOutput = z.infer<typeof TelegramAgentOutputSchema>

/**
 * The Telegram coding agent pipeline
 *
 * Flow:
 * 1. Check idempotency (has this message been seen?)
 * 2. If seen, return early with "already handled"
 * 3. If not seen, process the message
 * 4. Mark as seen in state
 * 5. Return result
 */
export const telegramCodingAgent: Pipeline<TelegramInput, TelegramAgentOutput> = pipeline({
  id: 'telegram-coding-agent',
  input: TelegramInputSchema,
  steps: [
    // Step 1: Idempotent check - if we've seen this message, skip processing
    idempotent<TelegramAgentOutput>({
      id: 'process',
      key: (ctx) => `msg:${(ctx.input as TelegramInput).messageId}`,
      step: code({
        id: 'process',
        run: async (ctx) => {
          const input = ctx.input as TelegramInput

          // Simulate message classification
          const isCodingRequest =
            input.text.toLowerCase().includes('code') ||
            input.text.toLowerCase().includes('fix') ||
            input.text.toLowerCase().includes('implement')

          if (!isCodingRequest) {
            return {
              handled: false,
              reason: 'Not a coding request',
              response: "I'm a coding assistant - please send me code-related tasks!",
            }
          }

          // Simulate processing a coding request
          // In a real implementation, this would:
          // - Parse the request
          // - Make code changes in the workspace
          // - Create a PR
          // - Reply to the user

          return {
            handled: true,
            reason: 'Coding request processed',
            response: `I'll work on: "${input.text}"\n\nChanges will be committed to the workspace.`,
          }
        },
      }),
    }),
  ],
  finalize: (ctx) => ctx.steps.process as TelegramAgentOutput,
})

/**
 * Variant with full agent step and MCP integration
 *
 * This version shows how the pipeline would work with a real agent
 * and MCP server. For testing, we use the mock Telegram MCP.
 */
export const telegramCodingAgentWithMCP: Pipeline<TelegramInput, TelegramAgentOutput> = pipeline({
  id: 'telegram-coding-agent-full',
  input: TelegramInputSchema,
  steps: [
    // Idempotent wrapper around the agent step
    idempotent<TelegramAgentOutput>({
      id: 'agent-process',
      key: (ctx) => `msg:${(ctx.input as TelegramInput).messageId}`,
      step: agent({
        id: 'agent-process',
        backend: 'mock-backend', // Would be 'copilot-acp' in production
        workspace: {
          mode: 'persistent' as const,
          name: 'telegram-coding-main',
          gitRoot: true,
        },
        mcp: [
          {
            id: 'telegram',
            transport: {
              type: 'stdio' as const,
              command: 'mock-telegram-mcp', // Would be actual MCP server
            },
          },
        ],
        permissions: {
          allowedTools: ['telegram.send_message', 'telegram.read_message'],
          allowedExecutables: ['git', 'pnpm', 'rg'],
          networkEgress: {
            allowHosts: ['api.telegram.org', 'api.github.com'],
          },
        },
        prompt: (ctx) => {
          const input = ctx.input as TelegramInput
          return `You are a coding assistant on Telegram.

User Message: "${input.text}"
From: ${input.from}
Chat: ${input.chatId}

Tasks:
1. Determine if this is a coding request
2. If yes, make the necessary code changes in your workspace
3. Commit changes with a descriptive message
4. Reply to the user with what you did

Available tools:
- telegram.send_message: Send a reply to the user
- telegram.read_message: Read conversation history
- git: Version control
- pnpm: Package manager
- rg: Code search

Remember: This is a persistent workspace. Changes persist across runs.
`
        },
        output: TelegramAgentOutputSchema,
      }),
    }),
  ],
  finalize: (ctx) => ctx.steps['agent-process'] as TelegramAgentOutput,
})

export default telegramCodingAgent
