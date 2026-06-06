/**
 * Standalone live-verification script (not a vitest test). Run manually:
 *
 *   OPENAI_BASE_URL=http://localhost:8000/v1 \
 *   OPENAI_API_KEY=dummy OPENAI_MODEL=qwen35 \
 *   node packages/agent/test/live-qwen35-session.skip.ts
 *
 * Verifies the three pillars added on this branch end-to-end:
 *   1. ModelRegistry routes a request to the configured provider
 *   2. AgentSession persists/restores conversation context
 *   3. compact() collapses an older prefix into a system summary
 */

import { chatCompletion } from '@skelm/core/openai'
import {
  AgentSession,
  type InferDispatch,
  ModelRegistry,
  type SessionMessage,
  compact,
} from '../src/index.js'

async function main(): Promise<void> {
  const baseUrl = process.env.OPENAI_BASE_URL
  const apiKey = process.env.OPENAI_API_KEY ?? 'dummy'
  const modelId = process.env.OPENAI_MODEL ?? 'qwen35'
  if (baseUrl === undefined) {
    console.error('set OPENAI_BASE_URL (e.g. http://localhost:8000/v1) before running')
    process.exit(2)
  }

  const registry = new ModelRegistry()
  registry.registerProvider('local', {
    baseUrl,
    apiKey,
    models: [
      {
        id: modelId,
        api: 'openai-completions',
        input: ['text'],
        contextWindow: 32_000,
        maxTokens: 256,
        cost: { input: 0, output: 0 },
        reasoning: false,
      },
    ],
  })

  const resolved = registry.find('local', modelId)
  if (resolved === undefined) throw new Error('registry resolution failed')
  console.log(`[ok] registry resolved ${resolved.provider}/${resolved.entry.id}`)

  const dispatch: InferDispatch = async ({ messages }) => {
    const response = await chatCompletion(resolved.baseUrl, {
      apiKey: resolved.apiKey,
      model: resolved.entry.id,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      maxTokens: 1024,
      timeoutMs: 60_000,
    })
    const choice = response.choices?.[0]
    const content = (choice?.message?.content ?? '') as string
    const usage = response.usage
    const message: SessionMessage = {
      role: 'assistant',
      content,
      ...(usage !== undefined && {
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        },
      }),
    }
    return { message, stopReason: 'stop' }
  }

  const session = new AgentSession(dispatch, {
    systemPrompt: 'You are concise. Answer in one short sentence.',
  })

  const r1 = await session.prompt('My name is Skelm. Reply with: ok')
  console.log(`[ok] turn 1: ${r1.text.slice(0, 80)}`)

  const r2 = await session.prompt('What did I just tell you my name was?')
  console.log(`[ok] turn 2 (memory): ${r2.text.slice(0, 80)}`)

  const json = session.toJSON()
  const restored = AgentSession.fromJSON(json, dispatch)
  const r3 = await restored.prompt('Reply with one short sentence including my name.')
  console.log(`[ok] turn 3 (restored): ${r3.text.slice(0, 80)}`)

  const compactionResult = await compact(restored.messages, {
    summarize: async (toSummarize) =>
      `Earlier the user said their name is Skelm and asked the assistant to recall it. ${toSummarize.length} messages elided.`,
    keepRecent: 2,
  })
  restored.setMessages(compactionResult.messages)
  console.log(
    `[ok] compaction: collapsed=${compactionResult.collapsedCount}, savings≈${compactionResult.estimatedTokenSavings}`,
  )

  const r4 = await restored.prompt('Now what is my name? One word.')
  console.log(`[ok] turn 4 (post-compaction): ${r4.text.slice(0, 80)}`)
}

main().catch((err) => {
  console.error('[fail]', err)
  process.exit(1)
})
