import { describe, expect, it } from 'vitest'
import { EmailMessageError } from '../src/errors.js'
import { sendEmail, shapeOutboundMessage } from '../src/smtp.js'
import { RESOLVED_CREDS, makeSmtpFake } from './fakes.js'

describe('shapeOutboundMessage', () => {
  it('normalizes string recipients to address objects', () => {
    const msg = shapeOutboundMessage({
      from: 'me@example.test',
      to: 'a@example.test',
      cc: ['b@example.test', { address: 'c@example.test', name: 'C' }],
      subject: 'hi',
      text: 'body',
    })
    expect(msg.from).toEqual({ address: 'me@example.test' })
    expect(msg.to).toEqual([{ address: 'a@example.test' }])
    expect(msg.cc).toEqual([
      { address: 'b@example.test' },
      { address: 'c@example.test', name: 'C' },
    ])
  })

  it('carries subject, html, attachments, and headers through', () => {
    const msg = shapeOutboundMessage({
      from: 'me@example.test',
      to: 'a@example.test',
      subject: 'subj',
      html: '<p>hi</p>',
      attachments: [{ filename: 'a.txt', content: 'data', contentType: 'text/plain' }],
      headers: { 'X-Trace': '1' },
    })
    expect(msg.html).toBe('<p>hi</p>')
    expect(msg.attachments?.[0]).toEqual({
      filename: 'a.txt',
      content: 'data',
      contentType: 'text/plain',
    })
    expect(msg.headers).toEqual({ 'X-Trace': '1' })
  })

  it('rejects a message with neither text nor html', () => {
    expect(() =>
      shapeOutboundMessage({ from: 'me@example.test', to: 'a@example.test', subject: 's' }),
    ).toThrow(EmailMessageError)
  })

  it('rejects an empty recipient list', () => {
    expect(() =>
      shapeOutboundMessage({ from: 'me@example.test', to: [], subject: 's', text: 'b' }),
    ).toThrow(EmailMessageError)
  })
})

describe('sendEmail', () => {
  it('constructs the transport from resolved creds and sends the shaped message', async () => {
    const { factory, transports } = makeSmtpFake()
    const result = await sendEmail(
      { from: 'me@example.test', to: 'a@example.test', subject: 's', text: 'b' },
      RESOLVED_CREDS,
      factory,
    )
    expect(result.accepted).toEqual(['a@example.test'])
    expect(transports[0]?.sent).toHaveLength(1)
    expect(transports[0]?.receivedCreds?.password).toBe('super-secret-password')
  })

  it('defaults TLS on when secure is omitted', async () => {
    const { factory, transports } = makeSmtpFake()
    await sendEmail(
      { from: 'me@example.test', to: 'a@example.test', subject: 's', text: 'b' },
      RESOLVED_CREDS,
      factory,
    )
    expect(transports[0]?.receivedCreds?.secure).toBe(true)
  })

  it('honors an explicit secure: false (does not silently re-enable TLS)', async () => {
    const { factory, transports } = makeSmtpFake()
    await sendEmail(
      { from: 'me@example.test', to: 'a@example.test', subject: 's', text: 'b' },
      { ...RESOLVED_CREDS, secure: false },
      factory,
    )
    expect(transports[0]?.receivedCreds?.secure).toBe(false)
  })

  it('closes the transport even when send throws', async () => {
    const { factory, transports } = makeSmtpFake({ failSend: new Error('boom') })
    await expect(
      sendEmail(
        { from: 'me@example.test', to: 'a@example.test', subject: 's', text: 'b' },
        RESOLVED_CREDS,
        factory,
      ),
    ).rejects.toThrow('boom')
    expect(transports[0]?.closed()).toBe(true)
  })
})
