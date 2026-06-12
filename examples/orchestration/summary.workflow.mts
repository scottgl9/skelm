import { code, pipeline } from '@skelm/core'

/**
 * Child workflow the parent invokes synchronously before fanning out. Its
 * declared permissions are intersected with whatever the parent step holds,
 * so it can never exceed the parent (the delegation ceiling).
 */
export default pipeline({
  id: 'orchestration-summary',
  description: 'Builds the header for a triage report.',
  steps: [
    code({
      id: 'header',
      run: (ctx) => {
        const { count } = ctx.input as { count: number }
        return { title: `Triage of ${count} report(s)`, startedAt: new Date().toISOString() }
      },
    }),
  ],
})
