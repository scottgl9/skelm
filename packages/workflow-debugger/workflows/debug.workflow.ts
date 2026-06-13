import { code, pipeline } from '@skelm/core'
import {
  GatewayDebugHttpClient,
  analyzeFailedRun,
  parseWorkflowDebuggerConfig,
} from '@skelm/workflow-debugger'

// Workflow entry for @skelm/workflow-debugger. Given `{ runId }`, it fetches a
// failed run's timeline/audit/artifacts through the gateway (read-only, bearer
// by reference) and returns a redacted DebugReport. It declares no permissions
// beyond the secret it needs (default-deny); it never executes a run or writes
// source — any proposed edit is surfaced as a reviewable dry-run preview.

interface DebugInput {
  runId: string
  gatewayUrl?: string
  /** Name of the env var holding the gateway bearer token. */
  tokenRef?: string
}

export default pipeline({
  id: 'workflow-debugger',
  description: 'Ingest a failed run and produce a redacted debug report.',
  steps: [
    code({
      id: 'analyze',
      secrets: ['SKELM_GATEWAY_TOKEN'],
      run: async (ctx) => {
        const input = (ctx.input ?? {}) as DebugInput
        if (typeof input.runId !== 'string' || input.runId.length === 0) {
          throw new Error('workflow-debugger: input.runId is required')
        }
        const config = parseWorkflowDebuggerConfig({
          ...(input.gatewayUrl !== undefined ? { gatewayUrl: input.gatewayUrl } : {}),
          ...(input.tokenRef !== undefined ? { tokenRef: input.tokenRef } : {}),
        })
        const tokenRef = input.tokenRef ?? config.tokenRef ?? 'SKELM_GATEWAY_TOKEN'
        const token = ctx.secrets?.get(tokenRef)
        const client = new GatewayDebugHttpClient({
          url: config.gatewayUrl,
          timeoutMs: config.timeoutMs,
          ...(typeof token === 'string' ? { token } : {}),
        })
        return analyzeFailedRun(input.runId, client)
      },
    }),
  ],
})
