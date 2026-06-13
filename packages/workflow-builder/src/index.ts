// @skelm/workflow-builder — a persistent-agent workflow package that inspects,
// authors, and revises skelm workflows as REVIEWABLE patches. Writes flow only
// through the gateway round-trip apply route (dry-run-default,
// codeOwned-preserving); the agent's permissions are declared and default-deny,
// fsRead-scoped to the project. See the README and docs/reference/workflow-builder.md.

export { WorkflowBuilder } from './builder.js'
export type { WorkflowBuilderOptions } from './builder.js'
export { createProjectSource, assertInsideProject } from './project.js'
export {
  createGatewayApplyRoute,
  createGatewayValidateRunner,
} from './gateway-client.js'
export type { GatewayClientOptions } from './gateway-client.js'
export type {
  ApplyRoute,
  InspectedWorkflow,
  ProjectSource,
  ReviewablePatch,
  ValidateRunner,
  ValidationOutcome,
} from './types.js'
