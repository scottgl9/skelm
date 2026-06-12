import { code, pipeline } from '@skelm/core'

export default pipeline<{ name?: string }, { greeting: string }>({
  id: 'hello',
  steps: [
    code({
      id: 'greet',
      run: (input: { name?: string }) => ({ greeting: `hello ${input.name ?? 'world'}` }),
    }),
  ],
})
