export class IntegrationError extends Error {
  override readonly name: string = 'IntegrationError'
  constructor(
    message: string,
    readonly integrationId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export class IntegrationConfigError extends IntegrationError {
  override readonly name: string = 'IntegrationConfigError'
}

export class IntegrationStateError extends IntegrationError {
  override readonly name: string = 'IntegrationStateError'
}

export class IntegrationApiError extends IntegrationError {
  override readonly name: string = 'IntegrationApiError'
  constructor(
    message: string,
    integrationId: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, integrationId, options)
  }
}
