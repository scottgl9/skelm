import { infer, pipeline } from '@skelm/core'

export default pipeline({
  id: 'openai-default',
  steps: [
    infer({
      id: 'greet',
      prompt: 'say hi',
    }),
  ],
})
