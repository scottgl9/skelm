import { llm, pipeline } from '@skelm/core'

export default pipeline({
  id: 'openai-default',
  steps: [
    llm({
      id: 'greet',
      prompt: 'say hi',
    }),
  ],
})
