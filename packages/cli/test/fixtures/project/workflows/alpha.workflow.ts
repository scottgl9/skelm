import { code, pipeline } from '@skelm/core'

export default pipeline({
  id: 'alpha-workflow',
  description: 'Alpha workflow for CLI discovery and history tests',
  steps: [
    code({
      id: 'hello',
      run: () => ({ ok: true }),
    }),
  ],
})
