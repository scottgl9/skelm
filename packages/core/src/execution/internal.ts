import type { Context } from '../types.js'

/** Matches the `secrets` field shape on Context. */
export interface SecretsAccessor {
  get(name: string): string | undefined
}

/**
 * Wrap a resolved-secrets record in the accessor shape steps see on
 * `ctx.secrets`. Returns `undefined` if no secrets were resolved so callers
 * can skip the `secrets` overlay on the step context.
 */
export function createSecretsAccessor(
  resolvedSecrets: Record<string, string> | undefined,
): SecretsAccessor | undefined {
  if (resolvedSecrets === undefined) return undefined
  return { get: (name: string) => resolvedSecrets[name] }
}

/**
 * Resolve a value that may be either a literal `T` or a function `(ctx) => T`.
 * The authoring API accepts both forms for prompt/system/workspace/mcp/input.
 */
export function resolveValueOrFn<T>(value: T | ((ctx: Context) => T), ctx: Context): T {
  return typeof value === 'function' ? (value as (ctx: Context) => T)(ctx) : value
}

/**
 * Resolve a value that may be a literal `T`, a sync function `(ctx) => T`,
 * or an async function `(ctx) => Promise<T>`. Use this in hot paths that may
 * receive Promise-returning resolvers (e.g. prompts that read image bytes
 * from disk via `imagePartFromFile`). Always returns a Promise.
 */
export async function resolveValueOrFnAsync<T>(
  value: T | ((ctx: Context) => T | Promise<T>),
  ctx: Context,
): Promise<T> {
  return typeof value === 'function'
    ? await (value as (ctx: Context) => T | Promise<T>)(ctx)
    : value
}
