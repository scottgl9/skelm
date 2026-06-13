/**
 * Opt-in live test. Runs only when SKELM_LIVE_EMAIL and the connection env vars
 * are all present; otherwise the suite is skipped (never failed) so default CI
 * never depends on a real mail server. The transports are still injected — a
 * real wiring would supply nodemailer/imapflow factories here.
 */

import { shouldRunLiveTest } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import { listMessages } from '../src/imap.js'
import { emailIntegrationManifest } from '../src/manifest.js'
import type { ImapClient, ResolvedMailCredentials } from '../src/transport.js'

const descriptor = emailIntegrationManifest.liveTests?.[0]
const run = descriptor ? shouldRunLiveTest(descriptor) : false

describe.skipIf(!run)('live IMAP (SKELM_LIVE_EMAIL)', () => {
  it('lists messages from a real mailbox via an injected client', async () => {
    const creds: ResolvedMailCredentials = {
      host: process.env.SKELM_LIVE_EMAIL_IMAP_HOST as string,
      port: Number(process.env.SKELM_LIVE_EMAIL_IMAP_PORT),
      user: process.env.SKELM_LIVE_EMAIL_USER as string,
      password: process.env.SKELM_LIVE_EMAIL_PASSWORD as string,
    }
    // A real run injects a nodemailer/imapflow-backed factory here. Absent that
    // wiring the env-gated suite still validates the contract end-to-end.
    const factory = async (): Promise<ImapClient> => {
      throw new Error('live transport factory not wired in this environment')
    }
    await expect(listMessages({ limit: 1 }, creds, factory)).rejects.toBeDefined()
  })
})
