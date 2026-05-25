import { BackendConfigError } from '@skelm/core'

/**
 * Convert a step's output schema into the strict JSON Schema the Codex SDK
 * requires. Codex writes `outputSchema` to a file and passes it to the OpenAI
 * structured-output API via `--output-schema`; that API rejects any object
 * schema that omits `additionalProperties: false` or doesn't list every
 * property in `required`. The schema reaching this point is a standard-schema
 * (Zod is the documented default) or an already-plain JSON Schema object.
 *
 * Returns `undefined` when no schema was requested.
 */
export async function toCodexOutputSchema(
  schema: unknown,
): Promise<Record<string, unknown> | undefined> {
  if (schema === undefined) return undefined
  const json = await toJsonSchema(schema)
  return enforceStrict(json) as Record<string, unknown>
}

async function toJsonSchema(schema: unknown): Promise<unknown> {
  if (typeof schema !== 'object' || schema === null) {
    throw new BackendConfigError(
      'codex outputSchema must be a Zod schema or a JSON Schema object',
      'codex',
    )
  }
  const standard = (schema as { '~standard'?: { vendor?: unknown } })['~standard']
  if (standard !== undefined) {
    if (standard.vendor !== 'zod') {
      throw new BackendConfigError(
        `codex outputSchema: cannot convert a '${String(standard.vendor)}' schema to JSON Schema; use Zod or pass a JSON Schema object`,
        'codex',
      )
    }
    const z = (await import('zod')) as {
      toJSONSchema?: (s: unknown) => unknown
      default?: { toJSONSchema?: (s: unknown) => unknown }
    }
    const fn = z.toJSONSchema ?? z.default?.toJSONSchema
    if (typeof fn !== 'function') {
      throw new BackendConfigError('codex outputSchema: installed zod lacks toJSONSchema', 'codex')
    }
    return fn(schema)
  }
  // Already a plain JSON Schema object.
  return schema
}

/**
 * Deep-clone the JSON Schema, forcing `additionalProperties: false` and
 * `required: <all keys>` on every object node (recursing through properties,
 * items, $defs/definitions, and the anyOf/oneOf/allOf combinators). This is
 * what OpenAI strict structured output demands.
 */
function enforceStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceStrict)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = enforceStrict(value)
  }
  const props = out.properties
  if (out.type === 'object' || (props !== null && typeof props === 'object')) {
    out.additionalProperties = false
    if (props !== null && typeof props === 'object') {
      out.required = Object.keys(props as Record<string, unknown>)
    }
  }
  return out
}
