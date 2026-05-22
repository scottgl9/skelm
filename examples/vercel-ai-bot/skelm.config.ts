import { createOpenAI } from '@ai-sdk/openai'
import { defineConfig } from '@skelm/core'
import { createVercelAiBackend } from '@skelm/vercel-ai'

// Point @ai-sdk/openai at any OpenAI-compatible endpoint:
//   - cloud:        OPENAI_BASE_URL unset, OPENAI_API_KEY=<key>
//   - local server: OPENAI_BASE_URL=http://localhost:8000/v1, OPENAI_API_KEY=unused
const openai = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY ?? 'unused',
})

const modelId = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

export default defineConfig({
  registries: {
    workflows: { glob: '*.pipeline.{mts,ts}' },
  },
  backends: { agent: 'vercel-ai' },
  instances: [
    createVercelAiBackend({
      id: 'vercel-ai',
      model: openai(modelId),
    }),
  ],
})
