import { BackendCapabilityError, code, pipeline } from '@skelm/core'

// Fixture for EXIT.BACKEND_CAPABILITY — a step throws BackendCapabilityError
// to mimic a backend rejecting an unsupported capability (vision,
// agentmemory, tool kind, etc.).
export default pipeline({
  id: 'fixture-backend-capability',
  steps: [
    code({
      id: 'cap',
      run: () => {
        throw new BackendCapabilityError(
          'backend does not support vision input',
          'mock-backend',
          'vision',
        )
      },
    }),
  ],
})
