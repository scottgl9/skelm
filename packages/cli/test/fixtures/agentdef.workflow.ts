import { agent, pipeline } from '@skelm/core'

export default pipeline({
  id: 'agentdef-fixture',
  steps: [
    agent({
      id: 'greet',
      backend: 'anthropic',
      agentDef: './agents/greeter',
      prompt: 'Greet the user.',
    }),
  ],
})
