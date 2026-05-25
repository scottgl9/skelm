import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toCodexOutputSchema } from '../src/output-schema.js'

describe('toCodexOutputSchema', () => {
  it('returns undefined when no schema is requested', async () => {
    expect(await toCodexOutputSchema(undefined)).toBeUndefined()
  })

  it('converts a Zod object to strict JSON Schema', async () => {
    const schema = await toCodexOutputSchema(
      z.object({ path: z.string(), summary: z.string(), permissions: z.array(z.string()) }),
    )
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false })
    expect(schema?.required).toEqual(['path', 'summary', 'permissions'])
  })

  it('forces additionalProperties:false even when the Zod object is not strict', async () => {
    const schema = (await toCodexOutputSchema(z.object({ a: z.string() }))) as Record<
      string,
      unknown
    >
    expect(schema.additionalProperties).toBe(false)
  })

  it('recurses into nested object properties', async () => {
    const schema = (await toCodexOutputSchema(
      z.object({ meta: z.object({ id: z.string() }) }),
    )) as { properties: { meta: Record<string, unknown> } }
    expect(schema.properties.meta.additionalProperties).toBe(false)
    expect(schema.properties.meta.required).toEqual(['id'])
  })

  it('accepts an already-plain JSON Schema and enforces strictness', async () => {
    const schema = (await toCodexOutputSchema({
      type: 'object',
      properties: { x: { type: 'number' } },
    })) as Record<string, unknown>
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['x'])
  })

  it('throws a typed error for a non-object schema', async () => {
    await expect(toCodexOutputSchema('nope')).rejects.toMatchObject({ name: 'BackendConfigError' })
  })
})
