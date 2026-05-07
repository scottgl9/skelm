export class VercelAiBackendError extends Error {
  override readonly name: string = 'VercelAiBackendError'
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

export class VercelAiBackendTimeoutError extends VercelAiBackendError {
  override readonly name = 'VercelAiBackendTimeoutError'
}
