import { createOpenAI } from '@ai-sdk/openai'
import { createVercelAiBackend } from '@skelm/vercel-ai'

const openai = createOpenAI({
  baseURL: 'http://localhost:8000/v1',
  apiKey: 'unused',
})

const backend = createVercelAiBackend({
  id: 'vercel-ai',
  model: openai('qwen36'),
  maxOutputTokens: 512,
  timeout: 60_000,
})

console.log('--- infer() smoke ---')
const inferResult = await backend.infer(
  { messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }] },
  { signal: new AbortController().signal },
)
console.log('text:', JSON.stringify(inferResult.text))
console.log('usage:', inferResult.usage)
if (!inferResult.text || inferResult.text.length === 0) {
  console.error('FAIL: infer returned empty text')
  process.exit(1)
}

console.log('\n--- run() smoke ---')
const runResult = await backend.run(
  { prompt: 'Greet world warmly in one short sentence.', maxTurns: 1 },
  { signal: new AbortController().signal },
)
console.log('text:', JSON.stringify(runResult.text))
console.log('stopReason:', runResult.stopReason)
console.log('usage:', runResult.usage)
if (!runResult.text || runResult.text.length === 0) {
  console.error('FAIL: run returned empty text')
  process.exit(1)
}

console.log('\n--- OK ---')
