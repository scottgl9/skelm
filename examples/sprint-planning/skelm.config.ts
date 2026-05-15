import { createOpenAI } from '@ai-sdk/openai'
import { defineConfig } from '@skelm/core'
import { createVercelAiBackend } from '@skelm/vercel-ai'

const openai = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY ?? 'unused',
})

const modelId = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

export default defineConfig({
  registries: { workflows: { glob: '*.pipeline.ts' } },
  backends: { agent: 'vercel-ai' },
  defaults: {
    // vercel-ai is in-process; the gateway egress proxy can't intercept it,
    // so the backend refuses any networkEgress other than 'allow'. Per-step
    // permissions still narrow the rest of the surface (tools, fs, exec).
    permissions: { networkEgress: 'allow' },
  },
  instances: [createVercelAiBackend({ id: 'vercel-ai', model: openai(modelId) })],
})
