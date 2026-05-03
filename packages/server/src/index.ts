/**
 * @skelm/server — HTTP + SSE surface for skelm pipelines
 *
 * Thin transport layer on top of @skelm/core. Exposes:
 * - Pipeline discovery (GET /pipelines)
 * - Sync/async execution (POST /pipelines/:id/run, /start)
 * - Run control (GET /runs/:id, POST /runs/:id/resume, DELETE /runs/:id)
 * - SSE event streams (GET /runs/:id/stream)
 * - Schedule management (POST/GET/DELETE /schedules)
 */

export type { ServerConfig, AuthMode } from './config.js'
export { createServer } from './server.js'
export type { SkelmServer } from './types.js'
