import { code, pipeline } from '@skelm/core'
import { migrateN8nWorkflow } from '@skelm/migration-n8n'
import type { MigrateOptions, MigrationResult } from '@skelm/migration-n8n'

/**
 * The import workflow.
 *
 * Input is the n8n workflow JSON export — either the raw JSON text or the
 * already-parsed object — plus optional mapping overrides. Output is a
 * {@link MigrationResult}: a reviewable `pipeline(...)` source skeleton, the
 * required-integrations list, the unsupported-node list, and an optional
 * test-fixture stub.
 *
 * The generated source is for HUMAN REVIEW. This workflow does not write,
 * register, or activate anything — it returns a skeleton string for a person
 * to inspect, complete the TODOs in, and register deliberately.
 */
interface ImportInput {
  /** Raw JSON text or a parsed n8n export object. */
  export: unknown
  /** Optional mapping overrides. */
  options?: MigrateOptions
}

export default pipeline<ImportInput, MigrationResult>({
  id: 'import',
  description: 'Import an n8n workflow JSON export into a reviewable skelm skeleton.',
  steps: [
    code<MigrationResult>({
      id: 'migrate',
      run: (ctx) => {
        const input = ctx.input as ImportInput
        return migrateN8nWorkflow(input.export, input.options ?? {})
      },
    }),
  ],
  finalize: (ctx) => ctx.get<MigrationResult>('migrate') as MigrationResult,
})
