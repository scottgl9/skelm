import { IntegrationSdkError } from '@skelm/integration-sdk'

export class HttpIntegrationError extends IntegrationSdkError {
  override readonly name: string = 'HttpIntegrationError'
}

/** Thrown when the egress policy denies a request before it is sent. */
export class HttpEgressDeniedError extends HttpIntegrationError {
  override readonly name: string = 'HttpEgressDeniedError'
}

/** Thrown for 4xx responses that are not retryable. */
export class HttpClientError extends HttpIntegrationError {
  override readonly name: string = 'HttpClientError'
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
  }
}

/** Thrown for 5xx responses after all retry attempts are exhausted. */
export class HttpServerError extends HttpIntegrationError {
  override readonly name: string = 'HttpServerError'
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
  }
}

/** Thrown for network-level failures (DNS, connection refused, timeout). */
export class HttpNetworkError extends HttpIntegrationError {
  override readonly name: string = 'HttpNetworkError'
  readonly networkCause: unknown
  constructor(message: string, networkCause?: unknown) {
    super(message)
    this.networkCause = networkCause
  }
}
