import { z } from 'zod'

/**
 * Package configuration. All knobs are bounded and have safe defaults so the
 * workflows are deterministic and never unboundedly fan out against the
 * agentmemory server.
 */
export const MemorySystemConfigSchema = z
  .object({
    /** Project string forwarded to every agentmemory op. */
    project: z.string().min(1).default('default'),
    /** Max memories any single workflow recalls in one pass. */
    recallLimit: z.number().int().positive().max(1000).default(200),
    /** Age (ms) past which a memory is considered stale by stale-prune. */
    staleAfterMs: z
      .number()
      .int()
      .positive()
      .default(1000 * 60 * 60 * 24 * 30),
    /** Age (ms) past which weekly-archive folds a memory into the archive. */
    archiveAfterMs: z
      .number()
      .int()
      .positive()
      .default(1000 * 60 * 60 * 24 * 7),
    /** Minimum search score for consolidation to treat two memories as duplicates. */
    duplicateScore: z.number().min(0).max(1).default(0.9),
    /** Minimum recall score for promotion to elevate a memory. */
    promoteScore: z.number().min(0).max(1).default(0.75),
    /** Token budget hint for the summarization turn. */
    summaryMaxTokens: z.number().int().positive().max(8192).default(512),
  })
  .strict()

export type MemorySystemConfigInput = z.input<typeof MemorySystemConfigSchema>
export type MemorySystemConfig = z.output<typeof MemorySystemConfigSchema>

export function resolveMemorySystemConfig(input?: MemorySystemConfigInput): MemorySystemConfig {
  return MemorySystemConfigSchema.parse(input ?? {})
}
