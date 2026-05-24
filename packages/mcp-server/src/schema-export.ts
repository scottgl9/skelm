import type { SkelmSchema } from '@skelm/core'

export function exportInputSchema(schema: SkelmSchema | undefined): Record<string, unknown> {
  if (schema === undefined) return { type: 'object' }

  const typeName = readTypeName(schema)
  if (typeName !== 'ZodObject') return { type: 'object' }

  const shape = readObjectShape(schema)
  if (shape === undefined) return { type: 'object' }

  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = mapSchema(value)
    if (!isOptionalSchema(value)) required.push(key)
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function mapSchema(schema: unknown): Record<string, unknown> {
  const typeName = readTypeName(schema)

  switch (typeName) {
    case 'ZodString':
      return { type: 'string' }
    case 'ZodNumber':
      return { type: 'number' }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodArray': {
      const element = readArrayElement(schema)
      return {
        type: 'array',
        items: element === undefined ? {} : mapSchema(element),
      }
    }
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable': {
      const inner = readInnerSchema(schema)
      return inner === undefined ? {} : mapSchema(inner)
    }
    case 'ZodObject':
      return exportInputSchema(schema as SkelmSchema)
    default:
      return {}
  }
}

function isOptionalSchema(schema: unknown): boolean {
  const typeName = readTypeName(schema)
  return typeName === 'ZodOptional' || typeName === 'ZodDefault'
}

function readTypeName(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const def = '_def' in schema ? (schema as { _def?: Record<string, unknown> })._def : undefined
  if (def === undefined) return undefined

  const rawTypeName = def.typeName
  if (typeof rawTypeName === 'string') return rawTypeName

  const rawType = def.type
  if (typeof rawType === 'string') {
    switch (rawType) {
      case 'string':
        return 'ZodString'
      case 'number':
        return 'ZodNumber'
      case 'boolean':
        return 'ZodBoolean'
      case 'array':
        return 'ZodArray'
      case 'object':
        return 'ZodObject'
      case 'optional':
        return 'ZodOptional'
      case 'default':
        return 'ZodDefault'
      case 'nullable':
        return 'ZodNullable'
      default:
        return undefined
    }
  }

  return undefined
}

function readObjectShape(schema: unknown): Record<string, unknown> | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const def = '_def' in schema ? (schema as { _def?: Record<string, unknown> })._def : undefined
  const shape = def?.shape
  if (typeof shape === 'function') {
    const resolved = shape()
    return typeof resolved === 'object' && resolved !== null
      ? (resolved as Record<string, unknown>)
      : undefined
  }
  return typeof shape === 'object' && shape !== null
    ? (shape as Record<string, unknown>)
    : undefined
}

function readArrayElement(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return undefined
  const def = '_def' in schema ? (schema as { _def?: Record<string, unknown> })._def : undefined
  return def?.element ?? def?.type
}

function readInnerSchema(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return undefined
  const def = '_def' in schema ? (schema as { _def?: Record<string, unknown> })._def : undefined
  return def?.innerType ?? def?.inner
}
