import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySlackSignature } from '../src/slack.js'

describe('verifySlackSignature', () => {
  it('accepts a valid Slack signature', () => {
    const rawBody = JSON.stringify({ type: 'event_callback', event: { type: 'message' } })
    const timestamp = '1716076800'
    const secret = 'slack-signing-secret'
    const signature =
      'v0=' + createHmac('sha256', secret).update('v0:' + timestamp + ':' + rawBody).digest('hex')

    expect(verifySlackSignature(rawBody, signature, timestamp, secret)).toBe(true)
  })

  it('rejects an invalid Slack signature', () => {
    expect(
      verifySlackSignature('{"type":"event_callback"}', 'v0=deadbeef', '1716076800', 'secret'),
    ).toBe(false)
  })
})
