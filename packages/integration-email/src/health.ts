/**
 * Provider health checks for SMTP and IMAP.
 *
 * Each opens a transport/client from gateway-resolved credentials, calls
 * `verify()`, and reports a {@link ProviderHealthCheck}. `detail` never carries
 * a secret value: classification maps the failure to a short reason, and the
 * resolved password is confined to the factory closure.
 */

import type { ProviderHealthCheck } from '@skelm/integration-sdk'
import { classifyError } from './classify.js'
import type {
  ImapClientFactory,
  ResolvedMailCredentials,
  SmtpTransportFactory,
} from './transport.js'

function now(): string {
  return new Date().toISOString()
}

async function check(verify: () => Promise<void>, provider: string): Promise<ProviderHealthCheck> {
  try {
    await verify()
    return { healthy: true, status: 'ok', checkedAt: now(), detail: `${provider} reachable` }
  } catch (error) {
    const { class: errorClass, reason } = classifyError(error)
    return {
      healthy: false,
      status: errorClass === 'auth' ? 'unhealthy' : 'error',
      checkedAt: now(),
      detail: `${provider} check failed: ${reason}`,
    }
  }
}

/** Verify an SMTP connection. TLS defaults on. */
export async function checkSmtpHealth(
  creds: ResolvedMailCredentials,
  createTransport: SmtpTransportFactory,
): Promise<ProviderHealthCheck> {
  const secureCreds: ResolvedMailCredentials = { ...creds, secure: creds.secure ?? true }
  const transport = await createTransport(secureCreds)
  try {
    return await check(() => transport.verify(), 'smtp')
  } finally {
    await transport.close()
  }
}

/** Verify an IMAP connection. TLS defaults on. */
export async function checkImapHealth(
  creds: ResolvedMailCredentials,
  createClient: ImapClientFactory,
): Promise<ProviderHealthCheck> {
  const secureCreds: ResolvedMailCredentials = { ...creds, secure: creds.secure ?? true }
  const client = await createClient(secureCreds)
  try {
    return await check(() => client.verify(), 'imap')
  } finally {
    await client.close()
  }
}
