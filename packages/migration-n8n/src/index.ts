/**
 * @skelm/migration-n8n — import n8n workflow JSON exports into skelm
 * TypeScript workflow skeletons.
 *
 * The output is a reviewable `pipeline(...)` source string plus a
 * required-integrations list and a list of unsupported nodes flagged as TODO
 * comments. Generated code is for human review, never auto-activated.
 */
export { generateSkeleton } from './codegen.js'
export { N8nImportError } from './errors.js'
export { extractSampleInput, generateFixture } from './fixture.js'
export { mapNode, mapNodes, ruleForType, toStepId } from './mapping.js'
export { migrateN8nWorkflow } from './migrate.js'
export { parseN8nWorkflow } from './parser.js'
export type {
  MappedNode,
  MigrateOptions,
  MigrationResult,
  N8nConnections,
  N8nConnectionTarget,
  N8nNode,
  N8nWorkflow,
  SkelmStepKind,
  SkelmTriggerKind,
} from './types.js'
