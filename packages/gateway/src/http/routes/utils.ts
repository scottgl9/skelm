import type { Pipeline } from '@skelm/core'

export function decodeMaybe(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function extractPipeline(mod: unknown): Pipeline | undefined {
  if (isPipelineish(mod)) return mod as Pipeline
  if (typeof mod === 'object' && mod !== null) {
    const m = mod as Record<string, unknown>
    if (isPipelineish(m.default)) return m.default as Pipeline
  }
  return undefined
}

export function isPipelineish(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.steps) && typeof v.id === 'string'
}

/**
 * Best-effort conversion of a standard-schema-compatible schema into JSON Schema.
 * Currently understands Zod (via z.toJSONSchema, Zod 4+). Other vendors return null.
 */
export async function tryToJsonSchema(schema: unknown): Promise<unknown | null> {
  if (typeof schema !== 'object' || schema === null) return null
  const standard = (schema as { '~standard'?: { vendor?: unknown } })['~standard']
  const vendor = standard?.vendor
  if (vendor === 'zod') {
    try {
      const z = (await import('zod')) as {
        toJSONSchema?: (s: unknown) => unknown
        default?: { toJSONSchema?: (s: unknown) => unknown }
      }
      const fn = z.toJSONSchema ?? z.default?.toJSONSchema
      if (typeof fn !== 'function') return null
      return fn(schema)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Coerce a pipeline output into a string for OpenAI-shape responses.
 */
export function openaiContentFor(output: unknown): string {
  if (typeof output === 'string') return output
  if (output !== null && typeof output === 'object') {
    const o = output as Record<string, unknown>
    if (typeof o.content === 'string') return o.content
    if (typeof o.text === 'string') return o.text
  }
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}
