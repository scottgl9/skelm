// Self-test entry for @skelm/package-publisher. Default-exports a runtime-free
// smoke test: it secret-scans a string with a planted fake token (asserting a
// redacted hit) and a clean string (asserting no hit). Throws on failure so the
// publisher's self-test stage reports a failure.

import { scanText } from '@skelm/package-publisher'

export default function selfTest(): void {
  // Assembled from fragments so this file holds no contiguous token-shaped
  // literal (which would trip secret push-protection); the joined value is a
  // fake AWS-key-id shape the scanner flags.
  const planted = `const t = "${'AKIA'}${'IOSFODNN7EXAMPLE'}"`
  const hits = scanText('self-test.ts', planted)
  if (hits.length === 0) {
    throw new Error('self-test: secret scanner failed to flag a planted AWS key id')
  }
  for (const hit of hits) {
    if (hit.redacted.includes('IOSFODNN7')) {
      throw new Error('self-test: redacted finding leaked the raw secret interior')
    }
  }

  const clean = scanText('self-test.ts', 'export const greeting = "hello world"')
  if (clean.length !== 0) {
    throw new Error('self-test: secret scanner false-positived on ordinary code')
  }
}
