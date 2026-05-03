// Public surface of @skelm/core. Anything exported from this file is part
// of the public API; anything not re-exported here is internal.

export const VERSION = '0.0.0'

export { code, pipeline } from './builders.js'
export { RunCancelledError, StepError, serializeError } from './errors.js'
export { EventBus, terminalEventTypeFor } from './events.js'
export type { EventListener, RunEvent, RunEventType } from './events.js'
export type { RunOptions } from './runner.js'
export { runPipeline, SchemaValidationError } from './runner.js'
export type { SkelmSchema } from './schema.js'
export type {
  CodeStep,
  Context,
  Pipeline,
  Run,
  RunId,
  RunMetadata,
  RunStatus,
  SerializedError,
  Step,
  StepId,
  StepKind,
  StepResult,
  StepStatus,
} from './types.js'
