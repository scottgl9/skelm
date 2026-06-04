export class IntegrationSdkError extends Error {
  override readonly name: string = 'IntegrationSdkError'
}

export class IntegrationRateLimitError extends IntegrationSdkError {
  override readonly name: string = 'IntegrationRateLimitError'
}

export class IntegrationCredentialsError extends IntegrationSdkError {
  override readonly name: string = 'IntegrationCredentialsError'
}

export class IntegrationUnsupportedOperationError extends IntegrationSdkError {
  override readonly name: string = 'IntegrationUnsupportedOperationError'
}
