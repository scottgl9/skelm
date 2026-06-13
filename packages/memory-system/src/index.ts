// Public surface of @skelm/memory-system.

export { MemorySystemError } from './errors.js'

export {
  type MemorySystemConfig,
  type MemorySystemConfigInput,
  MemorySystemConfigSchema,
  resolveMemorySystemConfig,
} from './config.js'

export {
  buildWorkflowHandle,
  MEMORY_SECRET,
  type MemoryWorkflowId,
  WORKFLOW_PERMISSIONS,
} from './permissions.js'

export type {
  Clock,
  MemoryClient,
  MemoryLogEntry,
  MemoryLogger,
  MemoryRecord,
  MemorySystemDeps,
  Summarizer,
  WorkflowOutcome,
} from './types.js'

export { runDailyNote } from './workflows/daily-note.js'
export { runSessionSummary } from './workflows/session-summary.js'
export { runWeeklyArchive } from './workflows/weekly-archive.js'
export { runConsolidation } from './workflows/consolidation.js'
export { runPromotion } from './workflows/promotion.js'
export { runStalePrune } from './workflows/stale-prune.js'
export { runSearchHealth } from './workflows/search-health.js'
export { runIntegrityAudit } from './workflows/integrity-audit.js'
