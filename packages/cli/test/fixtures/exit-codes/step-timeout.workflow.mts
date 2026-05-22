import { code, pipeline } from '@skelm/core'

// Fixture for EXIT.STEP_TIMEOUT — a step whose body outlives timeoutMs
// is aborted via StepTimeoutError.
export default pipeline({
  id: 'fixture-step-timeout',
  steps: [
    code({
      id: 'sleeps',
      timeoutMs: 50,
      run: async (ctx) => {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 5_000)
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(t)
            resolve(undefined)
          })
        })
        return {}
      },
    }),
  ],
})
