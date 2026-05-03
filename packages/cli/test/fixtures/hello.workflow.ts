import { code, pipeline } from '@skelm/core'

export default pipeline<{ name: string }, { greeting: string }>({
  id: 'hello-fixture',
  steps: [
    code({
      id: 'greet',
      run: (ctx) => ({ greeting: `hello, ${(ctx.input as { name: string }).name}` }),
    }),
  ],
})
