import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * Re-export of the standard-schema interface so customers can supply Zod,
 * Valibot, Effect Schema, or any other validator that implements the
 * standard. The runtime calls `~standard.validate` and never reaches into
 * provider-specific APIs.
 */
export type SkelmSchema<T = unknown> = StandardSchemaV1<T>

/** Thrown when input or output fails schema validation at a run boundary. */
export class SchemaValidationError extends Error {
  override readonly name = 'SchemaValidationError'
  constructor(
    message: string,
    readonly where: 'input' | 'output',
    readonly issues: readonly StandardSchemaV1.Issue[],
    readonly context?: {
      stepId?: string
      pipelineId?: string
      rawValue?: unknown
    },
  ) {
    super(message)
  }
}

/**
 * Validate a value against a standard-schema validator. Returns the parsed
 * value (which may be a transformed copy depending on the validator) or
 * throws SchemaValidationError carrying issues for diagnostics.
 *
 * Synchronous wrapper that supports both sync and async validators by
 * returning a Promise; callers always await.
 */
export async function validate<T>(
  schema: SkelmSchema<T>,
  value: unknown,
  where: 'input' | 'output',
  context?: {
    stepId?: string
    pipelineId?: string
    rawValue?: unknown
  },
): Promise<T> {
  const maybe = schema['~standard'].validate(value)
  const result = await maybe
  if ('issues' in result && result.issues !== undefined) {
    const message = formatIssues(result.issues, where, context)
    throw new SchemaValidationError(message, where, result.issues, context)
  }
  return (result as { value: T }).value
}

function formatIssues(
  issues: readonly StandardSchemaV1.Issue[],
  where: 'input' | 'output',
  context?: {
    stepId?: string
    pipelineId?: string
    rawValue?: unknown
  },
): string {
  const parts: string[] = []
  
  // Add context header if available
  if (context?.stepId || context?.pipelineId) {
    const ctx = []
    if (context.pipelineId) ctx.push(`pipeline "${context.pipelineId}"`)
    if (context.stepId) ctx.push(`step "${context.stepId}"`)
    parts.push(`Validation failed for ${ctx.join(' in ')}`)
  } else {
    parts.push(`${where} validation failed`)
  }
  
  if (issues.length === 0) return parts.join('\n')
  
  const detail = issues
    .map((i) => {
      const path = i.path ? renderPath(i.path) : ''
      return path ? `${path}: ${i.message}` : i.message
    })
    .join('; ')
  
  parts.push(detail)
  
  // Add hint for common issues
  if (where === 'output' && context?.rawValue !== undefined) {
    if (typeof context.rawValue === 'string') {
      const trimmed = context.rawValue.trim()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        parts.push('Hint: Agent returned plain text instead of JSON. Check that the agent was instructed to return valid JSON.')
      }
    }
  }
  
  return parts.join('\n')
}

function renderPath(path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment>): string {
  return path
    .map((seg) => (typeof seg === 'object' && seg !== null ? String(seg.key) : String(seg)))
    .join('.')
}
