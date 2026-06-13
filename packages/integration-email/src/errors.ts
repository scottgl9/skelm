import { IntegrationSdkError } from '@skelm/integration-sdk'

/** Base error for the email integration. */
export class EmailIntegrationError extends IntegrationSdkError {
  override readonly name: string = 'EmailIntegrationError'
}

/** SMTP/IMAP authentication or credential-resolution failure. */
export class EmailAuthError extends EmailIntegrationError {
  override readonly name: string = 'EmailAuthError'
}

/** Transient connection/network failure that is safe to retry. */
export class EmailTransientError extends EmailIntegrationError {
  override readonly name: string = 'EmailTransientError'
}

/** A message could not be shaped/validated before send. */
export class EmailMessageError extends EmailIntegrationError {
  override readonly name: string = 'EmailMessageError'
}
