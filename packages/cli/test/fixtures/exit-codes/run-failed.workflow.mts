import { code, pipeline } from '@skelm/core'

// Fixture for EXIT.RUN_FAILED — any uncaught step error that isn't one
// of the more specific (schema / permission / timeout / wait) cases
// should exit with code 3.
export default pipeline({
  id: 'fixture-run-failed',
  steps: [
    code({
      id: 'boom',
      run: () => {
        throw new Error('intentional failure')
      },
    }),
  ],
})
