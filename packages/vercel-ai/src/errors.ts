/** Base error for the vercel-ai backend (inference + agent runs). */
export class VercelAiBackendError extends Error {
  override readonly name: string = 'VercelAiBackendError'
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

/** Thrown when a vercel-ai inference or run exceeds its timeout. */
export class VercelAiBackendTimeoutError extends VercelAiBackendError {
  override readonly name = 'VercelAiBackendTimeoutError'
}
