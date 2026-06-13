// Default workflow entrypoint for @skelm/package-publisher.
//
// Given `{ packageDir }` it validates the target workflow package's manifest,
// builds a references-only permission summary, secret-scans the contents,
// validates the declared self-test entry, and assembles a publish DRY-RUN. It never
// performs a real npm publish. A failing stage (invalid manifest, secret found,
// self-test failure) throws so the run is marked failed.

import { code, pipeline } from '@skelm/core'
import { runPublish } from '@skelm/package-publisher'

interface PublishInput {
  /** Absolute path to the target workflow-package directory. */
  packageDir: string
  /** Validate the declared self-test entry. Default true. */
  runSelfTest?: boolean
}

export default pipeline({
  id: 'package-publisher',
  description:
    'Validate, secret-scan, self-test entry-check, and publish-dry-run a workflow package.',
  steps: [
    code({
      id: 'publish',
      run: async (ctx) => {
        const input = ctx.input as PublishInput
        if (typeof input?.packageDir !== 'string' || input.packageDir.length === 0) {
          throw new Error('package-publisher: input.packageDir (absolute path) is required')
        }
        const report = await runPublish(input.packageDir, {
          ...(input.runSelfTest !== undefined && { runSelfTest: input.runSelfTest }),
        })
        if (!report.ok) {
          const reasons: string[] = []
          if (report.manifestError) reasons.push(`manifest: ${report.manifestError}`)
          if (report.secretFindings.length > 0) {
            reasons.push(`${report.secretFindings.length} likely secret(s) found`)
          }
          if (report.selfTest.status === 'failed') {
            reasons.push(`self-test failed: ${report.selfTest.detail ?? 'unknown'}`)
          }
          throw new Error(`package-publisher: publish checks failed — ${reasons.join('; ')}`)
        }
        return report
      },
    }),
  ],
})
