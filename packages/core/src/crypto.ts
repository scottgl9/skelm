import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time string compare. Returns false on length mismatch
 * (which itself only leaks the length, never the content) and falls
 * through to crypto.timingSafeEqual on the byte buffers.
 *
 * Use for any secret-equality check (tokens, signatures, webhook
 * secrets) where the alternative `a === b` would leak per-character
 * timing under a remote brute-force.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
