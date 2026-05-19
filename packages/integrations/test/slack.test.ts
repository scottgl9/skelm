import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySlackSignature } from '../src/slack.js'

function signSlack(rawBody: string, timestamp: string, secret: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
}

describe('verifySlackSignature', () => {
  const secret = 'signing-secret'
  const rawBody = JSON.stringify({ type: 'event_callback', event: { type: 'message' } })
  const timestamp = '1700000000'

  it('accepts a signature produced over the same body and timestamp', () => {
    const sig = signSlack(rawBody, timestamp, secret)
    expect(verifySlackSignature(rawBody, sig, timestamp, secret)).toBe(true)
  })

  it('rejects a signature when even a single body byte changes', () => {
    const sig = signSlack(rawBody, timestamp, secret)
    const tamperedBody = `${rawBody} `
    expect(verifySlackSignature(tamperedBody, sig, timestamp, secret)).toBe(false)
  })

  it('rejects a signature when the timestamp is changed', () => {
    const sig = signSlack(rawBody, timestamp, secret)
    expect(verifySlackSignature(rawBody, sig, '1700000001', secret)).toBe(false)
  })

  it('rejects a signature when the secret is wrong', () => {
    const sig = signSlack(rawBody, timestamp, secret)
    expect(verifySlackSignature(rawBody, sig, timestamp, 'other-secret')).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifySlackSignature(rawBody, 'v0=short', timestamp, secret)).toBe(false)
  })
})
