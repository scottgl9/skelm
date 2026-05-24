import { pipeline, wait } from '@skelm/core'

// Fixture for EXIT.RUN_PAUSED — a wait step with no timeout that
// nothing ever resumes. With the gateway-dispatched skelm run flow,
// the gateway parks the run in `status: 'waiting'` after the wait
// timeout elapses internally (kept short here to keep the test fast),
// and the CLI surfaces it as RUN_PAUSED rather than a misleading
// generic failure.
export default pipeline({
  id: 'fixture-wait-no-timeout',
  steps: [
    wait({
      id: 'pending',
      message: 'awaiting external resume',
    }),
  ],
})
