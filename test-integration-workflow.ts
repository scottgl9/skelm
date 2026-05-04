import { code, pipeline, agent } from '@skelm/core'
import { z } from 'zod'

// Integration test workflow for testing with real agent backends
// Run with: skelm run test-integration-workflow.ts --input '{"model":"qwen36"}'

export default pipeline({
  id: 'integration-test',
  description: 'Integration test with real agent backends',
  input: z.object({
    model: z.string().default('qwen36'),
  }),
  output: z.object({
    result: z.enum(['PASS', 'FAIL']),
    details: z.string(),
  }),
  steps: [
    code({
      id: 'setup',
      run: async (ctx) => {
        console.log('Integration test starting with model:', ctx.input.model)
        return { 
          timestamp: new Date().toISOString(),
          model: ctx.input.model 
        }
      },
    }),
    agent({
      id: 'test-agent',
      backend: 'opencode',
      agentDef: 'test-agent',
      prompt: (ctx) => `You are a test agent. Your only task is to respond with exactly this JSON: {"response":"Integration test successful"}. Do not add any other text.`,
      output: z.object({
        response: z.string(),
      }),
      permissions: {
        allowedTools: [],
        fsRead: [],
        fsWrite: [],
        networkEgress: { allowHosts: [] },
      },
      maxTurns: 2,
    }),
    code({
      id: 'verify',
      run: async (ctx) => {
        const response = ctx.steps['test-agent']?.response || ''
        const success = response.includes('Integration test successful')
        return { 
          result: success ? 'PASS' as const : 'FAIL' as const, 
          details: success ? 'Agent responded correctly' : `Unexpected response: ${response}`
        }
      },
    }),
  ],
})
