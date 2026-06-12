import { code, pipeline } from '@skelm/core'

/**
 * Fanout worker: scans one report for error lines. Deterministic on purpose so
 * the parent's merge logic is easy to follow (and to test). A report
 * containing "corrupt" fails, demonstrating how fanout strategies treat
 * partial failure.
 */
export default pipeline({
  id: 'orchestration-scan',
  description: 'Scans a single report and counts error lines.',
  steps: [
    code({
      id: 'scan',
      run: (ctx) => {
        const report = String(ctx.input ?? '')
        if (report.includes('corrupt')) {
          throw new Error(`report is corrupt: ${report.slice(0, 32)}`)
        }
        const errors = report
          .split('\n')
          .filter((line) => line.toLowerCase().includes('error')).length
        return { report, errors }
      },
    }),
  ],
})
