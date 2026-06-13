import { IntegrationSdkError } from '@skelm/integration-sdk'

/** A Discord REST API call returned a non-2xx status. */
export class DiscordApiError extends IntegrationSdkError {
  override readonly name = 'DiscordApiError'
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** The adapter was used before {@link DiscordAdapter.connect} ran. */
export class DiscordNotConnectedError extends IntegrationSdkError {
  override readonly name = 'DiscordNotConnectedError'
}
