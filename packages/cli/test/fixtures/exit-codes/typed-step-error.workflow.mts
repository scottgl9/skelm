import { code, pipeline } from '@skelm/core'

// Fixture for the CLI step.error renderer (BUG-087/088/089): a thrown error
// whose class name is meaningful (mirrors BackendCapabilityError et al.) must
// surface that name on the `! <step>:` line, not just the bare message.
class TypedBoomError extends Error {
  override readonly name = 'TypedBoomError'
}

export default pipeline({
  id: 'fixture-typed-step-error',
  steps: [
    code({
      id: 'boom',
      run: () => {
        throw new TypedBoomError('typed boom message')
      },
    }),
  ],
})
