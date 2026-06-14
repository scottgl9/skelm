import { describe, expect, it, vi } from 'vitest'
import { classifyError, isRetryableMailError } from '../src/classify.js'
import { EmailAuthError, EmailMessageError } from '../src/errors.js'
import { checkImapHealth, checkSmtpHealth } from '../src/health.js'
import { listMessages, pollMailbox } from '../src/imap.js'
import { EMAIL_AUDIT_REDACTION, redactMailFields } from '../src/redaction.js'
import { sendEmail, shapeOutboundMessage } from '../src/smtp.js'
import { RESOLVED_CREDS, SAMPLE_MESSAGE, makeImapFake, makeSmtpFake } from './fakes.js'

const PASSWORD = RESOLVED_CREDS.password

function deepContains(value: unknown, needle: string): boolean {
  return JSON.stringify(value ?? null).includes(needle)
}

describe('redaction policy', () => {
  it('covers the password and message bodies', () => {
    expect(EMAIL_AUDIT_REDACTION.redactPaths).toContain('credentials.password')
    expect(EMAIL_AUDIT_REDACTION.redactPaths).toContain('message.text')
    expect(EMAIL_AUDIT_REDACTION.redactPaths).toContain('message.html')
  })

  it('scrubs password, body text/html, and tokens recursively', () => {
    const scrubbed = redactMailFields({
      credentials: { user: 'u', password: PASSWORD },
      message: { subject: 'ok', text: 'secret body', html: '<b>secret</b>' },
      nested: [{ token: 'abc' }],
    })
    expect(deepContains(scrubbed, PASSWORD)).toBe(false)
    expect(deepContains(scrubbed, 'secret body')).toBe(false)
    expect(deepContains(scrubbed, 'abc')).toBe(false)
    expect(deepContains(scrubbed, 'ok')).toBe(true)
  })

  it('does not mutate its input', () => {
    const input = { password: PASSWORD }
    redactMailFields(input)
    expect(input.password).toBe(PASSWORD)
  })
})

describe('no secret leaks through results or events', () => {
  it('SMTP send result never contains the password', async () => {
    const { factory } = makeSmtpFake()
    const result = await sendEmail(
      { from: 'me@example.test', to: 'a@example.test', subject: 's', text: 'b' },
      RESOLVED_CREDS,
      factory,
    )
    expect(deepContains(result, PASSWORD)).toBe(false)
  })

  it('IMAP poll events and list payloads never contain the password', async () => {
    const { factory } = makeImapFake([SAMPLE_MESSAGE])
    const poll = await pollMailbox(RESOLVED_CREDS, factory)
    const list = await listMessages({}, RESOLVED_CREDS, factory)
    expect(deepContains(poll.events, PASSWORD)).toBe(false)
    expect(deepContains(list, PASSWORD)).toBe(false)
  })

  it('error messages from this package never embed the password', () => {
    const err = new EmailAuthError('authentication failed')
    expect(err.message.includes(PASSWORD)).toBe(false)
    const { reason } = classifyError(err)
    expect(reason.includes(PASSWORD)).toBe(false)
  })

  it('health-check detail never contains the password', async () => {
    const { factory: smtp } = makeSmtpFake({ failVerify: { code: 'EAUTH' } })
    const { factory: imap } = makeImapFake([], { failVerify: { code: 'ETIMEDOUT' } })
    const sh = await checkSmtpHealth(RESOLVED_CREDS, smtp)
    const ih = await checkImapHealth(RESOLVED_CREDS, imap)
    expect(deepContains(sh, PASSWORD)).toBe(false)
    expect(deepContains(ih, PASSWORD)).toBe(false)
  })
})

describe('error classification', () => {
  it('classifies auth errors as auth (not retryable)', () => {
    expect(classifyError({ code: 'EAUTH' }).class).toBe('auth')
    expect(classifyError({ responseCode: 535 }).class).toBe('auth')
    expect(isRetryableMailError({ code: 'EAUTH' })).toBe(false)
  })

  it('classifies connection errors as transient (retryable)', () => {
    expect(classifyError({ code: 'ETIMEDOUT' }).class).toBe('transient')
    expect(isRetryableMailError({ code: 'ECONNRESET' })).toBe(true)
  })

  it('classifies unknown errors conservatively as unknown', () => {
    expect(classifyError(new Error('weird')).class).toBe('unknown')
  })
})

describe('health checks', () => {
  it('reports ok when verify succeeds', async () => {
    const { factory } = makeSmtpFake()
    const result = await checkSmtpHealth(RESOLVED_CREDS, factory)
    expect(result.healthy).toBe(true)
    expect(result.status).toBe('ok')
  })

  it('reports unhealthy on auth failure and error on transient failure', async () => {
    const { factory: authFail } = makeSmtpFake({ failVerify: { code: 'EAUTH' } })
    const { factory: connFail } = makeImapFake([], { failVerify: { code: 'ECONNREFUSED' } })
    expect((await checkSmtpHealth(RESOLVED_CREDS, authFail)).status).toBe('unhealthy')
    expect((await checkImapHealth(RESOLVED_CREDS, connFail)).status).toBe('error')
  })

  it('does not read process.env for credentials', async () => {
    const spy = vi.spyOn(process, 'env', 'get')
    const { factory } = makeSmtpFake()
    await checkSmtpHealth(RESOLVED_CREDS, factory)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('SMTP header injection (CRLF) is rejected at shaping', () => {
  it('rejects CR/LF in subject, header keys/values, and address fields', () => {
    const base = { from: 'a@x.com', to: 'b@x.com', text: 'body' }
    const injections = [
      { ...base, subject: 'Hi\r\nBcc: evil@attacker.com' },
      { ...base, subject: 'Hi\nX-Injected: 1' },
      { ...base, subject: 'ok', headers: { 'X-Custom': 'v\r\nBcc: evil@attacker.com' } },
      { ...base, subject: 'ok', headers: { 'X-Bad\r\nBcc: e@x.com': 'v' } },
      { ...base, subject: 'ok', to: 'b@x.com\r\nBcc: evil@attacker.com' },
      { ...base, subject: 'ok', from: { address: 'a@x.com', name: 'A\r\nBcc: e@x.com' } },
      // Attachment metadata becomes MIME part headers (Content-Disposition /
      // Content-Type) — header injection one layer down in the message.
      {
        ...base,
        subject: 'ok',
        attachments: [{ filename: 'a.txt\r\nBcc: e@x.com', content: 'x' }],
      },
      {
        ...base,
        subject: 'ok',
        attachments: [{ filename: 'a.txt', content: 'x', contentType: 'text/plain\r\nX-I: 1' }],
      },
    ]
    for (const input of injections) {
      expect(() => shapeOutboundMessage(input as never)).toThrow(EmailMessageError)
    }
  })

  it('still accepts multi-line text/html bodies (only headers are CRLF-restricted)', () => {
    const msg = shapeOutboundMessage({
      from: 'a@x.com',
      to: 'b@x.com',
      subject: 'normal subject',
      text: 'line 1\r\nline 2\nline 3',
      html: '<p>a</p>\n<p>b</p>',
    } as never)
    expect(msg.text).toContain('line 2')
    expect(msg.html).toContain('<p>b</p>')
  })
})
