import { z } from 'zod'

/**
 * Package config. The bearer token is referenced by the NAME of the env var /
 * secret that holds it (`tokenRef`), never the literal value — the manifest and
 * config never carry secret values.
 */
export const WorkflowDebuggerConfigSchema = z.object({
  /** Gateway base URL, no trailing slash. */
  gatewayUrl: z.string().url().default('http://127.0.0.1:14738'),
  /** Name of the env var holding the bearer token. Resolved at runtime. */
  tokenRef: z.string().min(1).optional(),
  /** Per-request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().max(120_000).default(5000),
})

export type WorkflowDebuggerConfig = z.infer<typeof WorkflowDebuggerConfigSchema>
export type WorkflowDebuggerConfigInput = z.input<typeof WorkflowDebuggerConfigSchema>

export function parseWorkflowDebuggerConfig(
  input: WorkflowDebuggerConfigInput = {},
): WorkflowDebuggerConfig {
  return WorkflowDebuggerConfigSchema.parse(input)
}
