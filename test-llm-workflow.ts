import { code, pipeline, llm } from '@skelm/core'
import { z } from 'zod'

// Simple integration test using LLM backend directly
// This tests the model endpoint without going through the opencode SDK

export default pipeline({
  id: 'llm-integration-test',
  description: 'Simple LLM integration test',
  input: z.object({
    model: z.string().default('qwen36'),
  }),
  output: z.object({
    result: z.enum(['PASS', 'FAIL']),
    response: z.string(),
  }),
  steps: [
    code({
      id: 'setup',
      run: async (ctx) => {
        console.log('LLM integration test starting with model:', ctx.input.model)
        return { timestamp: new Date().toISOString() }
      },
    }),
    llm({
      id: 'test-llm',
      backend: 'http-llm',
      prompt: (ctx) => `Respond with exactly this JSON: {"answer":"LLM test successful"}`,
      output: z.object({
        answer: z.string(),
      }),
    }),
    code({
      id: 'verify',
      run: async (ctx) => {
        const answer = ctx.steps['test-llm']?.answer || ''
        const success = answer === 'LLM test successful'
        return { 
          result: success ? 'PASS' as const : 'FAIL' as const, 
          response: answer
        }
      },
    }),
  ],
})
