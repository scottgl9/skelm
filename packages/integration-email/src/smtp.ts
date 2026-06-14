/**
 * SMTP send action.
 *
 * The action shapes a {@link SendEmailInput} into a normalized
 * {@link OutboundMessage}, constructs an {@link SmtpTransport} from
 * gateway-resolved credentials via the injected factory, sends, and closes the
 * transport. The resolved password never leaves the factory closure and is
 * never logged: only the redaction-safe message metadata is observable.
 */

import { z } from 'zod'
import { EmailMessageError } from './errors.js'
import type {
  MailAddress,
  MailAttachment,
  OutboundMessage,
  ResolvedMailCredentials,
  SendResult,
  SmtpTransport,
  SmtpTransportFactory,
} from './transport.js'

// Reject CR/LF in any value that becomes an email header (subject, header keys
// and values, address fields). This package is transport-agnostic — it cannot
// assume the injected transport sanitizes — so it fails closed at shaping time
// to prevent SMTP header injection (smuggling Bcc/extra headers via "\r\n").
const noHeaderCrlf = (s: string): boolean => !/[\r\n]/.test(s)
const CRLF_MSG = 'must not contain CR or LF (header injection)'
const headerSafeString = z.string().refine(noHeaderCrlf, { message: CRLF_MSG })

const addressSchema = z.object({
  address: headerSafeString.min(1),
  name: headerSafeString.optional(),
})

const attachmentSchema = z.object({
  filename: z.string().min(1),
  content: z.union([z.string(), z.instanceof(Uint8Array)]),
  contentType: z.string().optional(),
})

/** Validated input to {@link sendEmail}. Addresses accept a string or object. */
export const sendEmailInputSchema = z
  .object({
    from: z.union([headerSafeString.min(1), addressSchema]),
    to: z.union([
      headerSafeString.min(1),
      addressSchema,
      z.array(z.union([headerSafeString, addressSchema])),
    ]),
    cc: z
      .union([headerSafeString, addressSchema, z.array(z.union([headerSafeString, addressSchema]))])
      .optional(),
    bcc: z
      .union([headerSafeString, addressSchema, z.array(z.union([headerSafeString, addressSchema]))])
      .optional(),
    subject: headerSafeString,
    text: z.string().optional(),
    html: z.string().optional(),
    attachments: z.array(attachmentSchema).optional(),
    headers: z.record(headerSafeString, headerSafeString).optional(),
  })
  .refine((v) => v.text !== undefined || v.html !== undefined, {
    message: 'email must have a text or html body',
  })

export type SendEmailInput = z.input<typeof sendEmailInputSchema>

type ParsedAddress = { address: string; name?: string | undefined }
type ParsedAddrInput = string | ParsedAddress | (string | ParsedAddress)[] | undefined

function toAddress(v: string | ParsedAddress): MailAddress {
  if (typeof v === 'string') return { address: v }
  return v.name !== undefined ? { address: v.address, name: v.name } : { address: v.address }
}

function toAddressList(v: ParsedAddrInput): readonly MailAddress[] | undefined {
  if (v === undefined) return undefined
  const arr = Array.isArray(v) ? v : [v]
  return arr.map(toAddress)
}

/**
 * Shape validated input into a normalized {@link OutboundMessage}. Pure and
 * transport-free so it can be unit-tested without any connection.
 */
export function shapeOutboundMessage(input: SendEmailInput): OutboundMessage {
  const parsed = sendEmailInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new EmailMessageError(parsed.error.issues.map((i) => i.message).join('; '))
  }
  const v = parsed.data
  const to = toAddressList(v.to)
  if (to === undefined || to.length === 0) {
    throw new EmailMessageError('email must have at least one recipient')
  }
  const cc = toAddressList(v.cc)
  const bcc = toAddressList(v.bcc)
  const attachments: readonly MailAttachment[] | undefined = v.attachments?.map((a) =>
    a.contentType !== undefined
      ? { filename: a.filename, content: a.content, contentType: a.contentType }
      : { filename: a.filename, content: a.content },
  )
  return {
    from: toAddress(v.from),
    to,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    subject: v.subject,
    ...(v.text !== undefined ? { text: v.text } : {}),
    ...(v.html !== undefined ? { html: v.html } : {}),
    ...(attachments ? { attachments } : {}),
    ...(v.headers ? { headers: v.headers } : {}),
  }
}

/**
 * Send an email. The gateway supplies `creds` (resolved at dispatch) and the
 * `createTransport` factory. TLS is on by default: when `creds.secure` is
 * omitted it is coerced to true before the factory sees it. The transport is
 * always closed, even on failure.
 */
export async function sendEmail(
  input: SendEmailInput,
  creds: ResolvedMailCredentials,
  createTransport: SmtpTransportFactory,
): Promise<SendResult> {
  const message = shapeOutboundMessage(input)
  const secureCreds: ResolvedMailCredentials = { ...creds, secure: creds.secure ?? true }
  const transport: SmtpTransport = await createTransport(secureCreds)
  try {
    return await transport.send(message)
  } finally {
    await transport.close()
  }
}
