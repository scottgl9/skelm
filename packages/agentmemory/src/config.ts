import { z } from 'zod'

export const AgentmemoryConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    url: z.string().url().default('http://localhost:3111'),
    secretName: z.string().optional(),
    timeoutMs: z.number().int().positive().default(3000),
  })
  .strict()

export type AgentmemoryConfigInput = z.input<typeof AgentmemoryConfigSchema>
export type AgentmemoryConfig = z.output<typeof AgentmemoryConfigSchema>

export const DEFAULT_AGENTMEMORY_BASE_PATH = '/agentmemory'
