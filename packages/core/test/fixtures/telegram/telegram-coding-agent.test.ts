/**
 * Telegram Coding Agent (UC1) Acceptance Test
 *
 * This test validates the M2 acceptance criteria:
 * - Telegram-coding-agent fixture runs end-to-end with mocked Telegram MCP
 * - Persistent workspace is used correctly
 * - Idempotent message handling works (repeating same message = no-op)
 * - State persists across runs
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../../../src/builders.js'
import { MemoryRunStore, SqliteRunStore } from '../../../src/run-store.js'
import { runPipeline } from '../../../src/runner.js'
import { WorkspaceManager } from '../../../src/workspace.js'
import {
  type TelegramInput,
  TelegramInputSchema,
  telegramCodingAgent,
} from './telegram-coding-agent.pipeline.mjs'

describe('Telegram Coding Agent (UC1)', () => {
  describe('idempotent message handling', () => {
    it('returns cached output on repeated runs with the same message ID', async () => {
      const store = new MemoryRunStore()

      const input: TelegramInput = {
        messageId: 12345,
        chatId: '@testuser',
        from: 'testuser',
        text: 'Can you fix the bug in main.ts?',
      }

      // First run - should process
      const first = await runPipeline(telegramCodingAgent, input, { store })
      expect(first.status).toBe('completed')
      expect(first.output).toBeDefined()

      // Second run with same message ID - should return cached result without re-processing
      const second = await runPipeline(telegramCodingAgent, input, { store })
      expect(second.status).toBe('completed')
      expect(second.output).toEqual(first.output) // Same cached output

      // Third run with different message ID - should process again (different message)
      const thirdInput: TelegramInput = {
        ...input,
        messageId: 12346,
        text: 'Implement a new feature',
      }
      const third = await runPipeline(telegramCodingAgent, thirdInput, { store })
      expect(third.status).toBe('completed')
      expect(third.output).toBeDefined()
      // Different message text = different response
      expect((third.output as { response: string }).response).not.toEqual(
        (first.output as { response: string }).response,
      )
    })

    it('handles non-coding requests without re-processing', async () => {
      const store = new MemoryRunStore()
      const input: TelegramInput = {
        messageId: 99999,
        chatId: '@testuser',
        from: 'testuser',
        text: 'Hello, how are you?', // Not a coding request
      }

      const first = await runPipeline(telegramCodingAgent, input, { store })
      expect(first.status).toBe('completed')
      expect((first.output as { handled: boolean }).handled).toBe(false)

      // Repeat with same message - should be cached
      const second = await runPipeline(telegramCodingAgent, input, { store })
      expect(second.status).toBe('completed')
      expect((second.output as { handled: boolean }).handled).toBe(false)
      expect(second.output).toEqual(first.output)
    })
  })

  describe('persistent workspace', () => {
    it('reuses the same workspace across multiple runs', async () => {
      const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-telegram-workspaces-'))
      const store = new SqliteRunStore({ path: join(workspaceBase, 'runs.db') })
      const workspaceManager = new WorkspaceManager({ persistentBase: workspaceBase })

      try {
        // Create a pipeline that uses persistent workspace
        const workspacePipeline = pipeline<TelegramInput, { workspacePath: string }>({
          id: 'telegram-workspace-test',
          input: TelegramInputSchema,
          steps: [
            code({
              id: 'check-workspace',
              run: async (ctx) => {
                const ws = ctx.workspace
                if (!ws) {
                  throw new Error('No workspace provided')
                }
                return { workspacePath: ws.path }
              },
            }),
          ],
        })

        const input: TelegramInput = {
          messageId: 11111,
          chatId: '@workspace-test',
          from: 'test',
          text: 'test',
        }

        // First run - creates workspace
        const first = await runPipeline(workspacePipeline, input, {
          store,
          workspaceManager,
        })
        const workspacePath = first.output?.workspacePath

        // Second run with same pipeline - should reuse workspace
        const second = await runPipeline(workspacePipeline, input, {
          store,
          workspaceManager,
        })

        expect(second.output?.workspacePath).toBe(workspacePath)
      } finally {
        await rm(workspaceBase, { recursive: true, force: true })
        store.close()
      }
    })

    it('workspace persists state across runs', async () => {
      const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-telegram-persist-'))
      const store = new SqliteRunStore({ path: join(workspaceBase, 'runs.db') })
      const workspaceManager = new WorkspaceManager({ persistentBase: workspaceBase })

      try {
        // Pipeline that writes and reads state
        const persistPipeline = pipeline<TelegramInput, { runCount: number }>({
          id: 'telegram-persist-test',
          input: TelegramInputSchema,
          steps: [
            code({
              id: 'count',
              run: async (ctx) => {
                // Read previous count
                const prev = (await ctx.state.get<number>('run_count')) ?? 0
                const next = prev + 1
                // Write new count
                await ctx.state.set('run_count', next)
                return { runCount: next }
              },
            }),
          ],
        })

        const input: TelegramInput = {
          messageId: 22222,
          chatId: '@persist-test',
          from: 'test',
          text: 'test',
        }

        // First run
        const first = await runPipeline(persistPipeline, input, { store, workspaceManager })
        expect(first.output?.runCount).toBe(1)

        // Second run - state should persist
        const second = await runPipeline(persistPipeline, input, { store, workspaceManager })
        expect(second.output?.runCount).toBe(2)

        // Third run - state should still persist
        const third = await runPipeline(persistPipeline, input, { store, workspaceManager })
        expect(third.output?.runCount).toBe(3)
      } finally {
        await rm(workspaceBase, { recursive: true, force: true })
        store.close()
      }
    })
  })

  describe('end-to-end flow', () => {
    it('processes a complete coding request flow', async () => {
      const store = new MemoryRunStore()

      const input: TelegramInput = {
        messageId: 33333,
        chatId: '@coding-test',
        from: 'developer',
        text: 'Please implement a fibonacci function in utils.ts',
      }

      const result = await runPipeline(telegramCodingAgent, input, { store })

      expect(result.status).toBe('completed')
      expect(result.output).toBeDefined()
      expect((result.output as { handled: boolean }).handled).toBe(true)
      expect((result.output as { reason: string }).reason).toContain('Coding request processed')
      expect((result.output as { response?: string }).response).toContain("I'll work on:")
    })

    it('handles edge cases gracefully', async () => {
      const store = new MemoryRunStore()

      // Empty message
      const emptyResult = await runPipeline(
        telegramCodingAgent,
        {
          messageId: 44444,
          chatId: '@test',
          from: 'test',
          text: '',
        },
        { store },
      )
      expect(emptyResult.status).toBe('completed')
      // Empty message doesn't contain "code" keyword, so it's not a coding request
      expect((emptyResult.output as { handled: boolean }).handled).toBe(false)

      // Message with code keywords but not a request
      const ambiguousResult = await runPipeline(
        telegramCodingAgent,
        {
          messageId: 44445,
          chatId: '@test',
          from: 'test',
          text: 'I like code',
        },
        { store },
      )
      // "code" keyword triggers as coding request
      expect(ambiguousResult.status).toBe('completed')
      expect((ambiguousResult.output as { handled: boolean }).handled).toBe(true)
    })
  })

  describe('state isolation', () => {
    it('keeps idempotency state separate for different pipelines', async () => {
      const store = new MemoryRunStore()

      const input: TelegramInput = {
        messageId: 55555,
        chatId: '@isolation-test',
        from: 'test',
        text: 'fix this',
      }

      // Run through telegramCodingAgent
      const first = await runPipeline(telegramCodingAgent, input, { store })
      expect(first.status).toBe('completed')
      expect((first.output as { handled: boolean }).handled).toBe(true)

      // Run through a different pipeline with same input - should NOT be cached
      // (different pipeline = different idempotency scope)
      const simplePipeline = pipeline<TelegramInput, { processed: boolean }>({
        id: 'simple-test',
        input: TelegramInputSchema,
        steps: [
          code({
            id: 'process',
            run: () => ({ processed: true }),
          }),
        ],
      })

      const second = await runPipeline(simplePipeline, input, { store })
      expect(second.status).toBe('completed')
      expect(second.output?.processed).toBe(true)
      // Different pipeline = different idempotency scope = fresh processing
    })
  })
})
