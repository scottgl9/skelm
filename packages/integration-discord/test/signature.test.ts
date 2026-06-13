import { sign as edSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DISCORD_SIGNATURE_HEADER,
  DISCORD_TIMESTAMP_HEADER,
  verifyDiscordInteraction,
  verifyDiscordInteractionFromHeaders,
} from '../src/index.js'

function makeKeypair(): { publicKeyHex: string; sign: (msg: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // Extract the raw 32-byte public key from the SPKI DER (last 32 bytes).
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKeyHex: raw.toString('hex'),
    sign: (msg: string) => edSign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex'),
  }
}

describe('verifyDiscordInteraction', () => {
  it('accepts a valid Ed25519 signature over timestamp + body', () => {
    const { publicKeyHex, sign } = makeKeypair()
    const timestamp = '1700000000'
    const rawBody = '{"type":1}'
    const signature = sign(`${timestamp}${rawBody}`)
    expect(
      verifyDiscordInteraction({ rawBody, signature, timestamp, publicKey: publicKeyHex }),
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const { publicKeyHex, sign } = makeKeypair()
    const timestamp = '1700000000'
    const signature = sign(`${timestamp}{"type":1}`)
    expect(
      verifyDiscordInteraction({
        rawBody: '{"type":2}',
        signature,
        timestamp,
        publicKey: publicKeyHex,
      }),
    ).toBe(false)
  })

  it('rejects a tampered timestamp', () => {
    const { publicKeyHex, sign } = makeKeypair()
    const rawBody = '{"type":1}'
    const signature = sign(`1700000000${rawBody}`)
    expect(
      verifyDiscordInteraction({
        rawBody,
        signature,
        timestamp: '1700000001',
        publicKey: publicKeyHex,
      }),
    ).toBe(false)
  })

  it('rejects a signature from a different key', () => {
    const a = makeKeypair()
    const b = makeKeypair()
    const timestamp = '1700000000'
    const rawBody = '{"type":1}'
    const signature = a.sign(`${timestamp}${rawBody}`)
    expect(
      verifyDiscordInteraction({ rawBody, signature, timestamp, publicKey: b.publicKeyHex }),
    ).toBe(false)
  })

  it('rejects malformed hex signature without throwing', () => {
    const { publicKeyHex } = makeKeypair()
    expect(
      verifyDiscordInteraction({
        rawBody: '{}',
        signature: 'not-hex!!',
        timestamp: '1',
        publicKey: publicKeyHex,
      }),
    ).toBe(false)
  })

  it('rejects a malformed public key without throwing', () => {
    expect(
      verifyDiscordInteraction({
        rawBody: '{}',
        signature: 'aa'.repeat(32),
        timestamp: '1',
        publicKey: 'short',
      }),
    ).toBe(false)
  })

  it('rejects empty signature or timestamp', () => {
    const { publicKeyHex } = makeKeypair()
    expect(
      verifyDiscordInteraction({
        rawBody: '{}',
        signature: '',
        timestamp: '1',
        publicKey: publicKeyHex,
      }),
    ).toBe(false)
    expect(
      verifyDiscordInteraction({
        rawBody: '{}',
        signature: 'aa',
        timestamp: '',
        publicKey: publicKeyHex,
      }),
    ).toBe(false)
  })
})

describe('verifyDiscordInteractionFromHeaders', () => {
  it('reads the case-insensitive headers and verifies', () => {
    const { publicKeyHex, sign } = makeKeypair()
    const timestamp = '1700000000'
    const rawBody = '{"type":1}'
    const signature = sign(`${timestamp}${rawBody}`)
    const headers = {
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    }
    expect(verifyDiscordInteractionFromHeaders({ headers, rawBody, publicKey: publicKeyHex })).toBe(
      true,
    )
  })

  it('returns false when a header is missing', () => {
    const { publicKeyHex } = makeKeypair()
    expect(
      verifyDiscordInteractionFromHeaders({
        headers: { [DISCORD_TIMESTAMP_HEADER]: '1' },
        rawBody: '{}',
        publicKey: publicKeyHex,
      }),
    ).toBe(false)
  })

  it('uses the first value of an array header', () => {
    const { publicKeyHex, sign } = makeKeypair()
    const timestamp = '1700000000'
    const rawBody = '{"type":1}'
    const signature = sign(`${timestamp}${rawBody}`)
    const headers = {
      [DISCORD_SIGNATURE_HEADER]: [signature, 'ignored'],
      [DISCORD_TIMESTAMP_HEADER]: timestamp,
    }
    expect(verifyDiscordInteractionFromHeaders({ headers, rawBody, publicKey: publicKeyHex })).toBe(
      true,
    )
  })
})
