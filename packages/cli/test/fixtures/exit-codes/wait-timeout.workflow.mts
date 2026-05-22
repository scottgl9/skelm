import { pipeline, wait } from '@skelm/core'

// Fixture for EXIT.WAIT_TIMEOUT — a wait step whose timeout elapses
// before any resume input arrives surfaces WaitTimeoutError, which
// maps to exit code 5.
export default pipeline({
  id: 'fixture-wait-timeout',
  steps: [
    wait({
      id: 'pending',
      message: 'never resolved',
      timeoutMs: 50,
    }),
  ],
})
