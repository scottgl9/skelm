export class AgentmemoryError extends Error {
  override readonly name = 'AgentmemoryError'
  constructor(
    message: string,
    readonly endpoint: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export class AgentmemoryConfigError extends Error {
  override readonly name = 'AgentmemoryConfigError'
}
