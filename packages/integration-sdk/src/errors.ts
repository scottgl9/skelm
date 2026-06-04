export class IntegrationSdkError extends Error {
  override readonly name: string = 'IntegrationSdkError'
}

export class IntegrationRateLimitError extends IntegrationSdkError {
  override readonly name: string = 'IntegrationRateLimitError'
}
