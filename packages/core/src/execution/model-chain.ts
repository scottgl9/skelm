import { ModelChainExhaustedError } from '../errors.js'

/**
 * Invoke `call` once per model id in order, returning the first success. If a
 * model errors, the next is tried on the SAME backend; if all fail, throws
 * {@link ModelChainExhaustedError} with the per-model causes in attempt order.
 *
 * Used for an `infer()` step's `model: ['a', 'b', …]` fallback list. Streaming
 * partials from a failed attempt may already have been emitted before fallover
 * — the contract is "last attempt wins", not transactional.
 */
export async function runWithModelFallback<T>(
  stepId: string,
  models: readonly string[],
  call: (model: string) => Promise<T>,
): Promise<T> {
  const attempts: { model: string; cause: unknown }[] = []
  for (const model of models) {
    try {
      return await call(model)
    } catch (err) {
      attempts.push({ model, cause: err })
    }
  }
  throw new ModelChainExhaustedError(stepId, attempts)
}
