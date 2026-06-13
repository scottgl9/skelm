import { describe, expect, it } from 'vitest'
import { SECRET_SCAN_RULES, redactSecret, scanText } from '../src/secret-scan.js'

// Planted FAKE values in the GitHub/AWS/Slack/etc. shapes — none are real.
// Each is ASSEMBLED FROM FRAGMENTS at runtime so no committed file contains a
// contiguous token-shaped literal (which would trip GitHub push protection);
// the joined runtime value still exercises the scanner's patterns.
const PLANTED = {
  github: `ghp_${'aB3dEf7Hj9kLmN2pQ4rS6tU8vWx1Yz0AbCdE'}`,
  githubFineGrained: `github_pat_11ABCDE0Y0${'aBcDeFgHiJkL_mNoPqRsTuVwXyZ012345'}`,
  awsKeyId: `AKIA${'3KL7MN2PQ4RS6TUV'}`,
  slack: `xoxb-${'2483742807-2483742807-Ak3jLmNoPqRsTuVwXyZ012'}`,
  google: `AIza${'SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q'}`,
  stripe: `sk_live_${'4eC39HqLyjWDarjtT1zdp7dcAbCdEfGh'}`,
  privateKey: `-----BEGIN RSA ${'PRIVATE KEY-----'}`,
  bearer: `Authorization: Bearer ${'abcDEF123456ghiJKL789012mnoPQR345678'}`,
  urlAuth: `postgres://admin:${'S3cretPass99'}@db.example.com:5432/app`,
}

describe('scanText pattern heuristics', () => {
  it('flags a GitHub PAT', () => {
    const f = scanText('a.ts', `const t = "${PLANTED.github}"`)
    expect(f.map((x) => x.rule)).toContain('github-token')
  })

  it('flags a GitHub fine-grained token', () => {
    const f = scanText('a.ts', PLANTED.githubFineGrained)
    expect(f.some((x) => x.rule === 'github-fine-grained-token')).toBe(true)
  })

  it('flags an AWS access key id', () => {
    const f = scanText('a.ts', `key = ${PLANTED.awsKeyId}`)
    expect(f.some((x) => x.rule === 'aws-access-key-id')).toBe(true)
  })

  it('flags a Slack token', () => {
    const f = scanText('a.ts', PLANTED.slack)
    expect(f.some((x) => x.rule === 'slack-token')).toBe(true)
  })

  it('flags a Google API key', () => {
    const f = scanText('a.ts', PLANTED.google)
    expect(f.some((x) => x.rule === 'google-api-key')).toBe(true)
  })

  it('flags a Stripe live key', () => {
    const f = scanText('a.ts', PLANTED.stripe)
    expect(f.some((x) => x.rule === 'stripe-secret-key')).toBe(true)
  })

  it('flags a PEM private-key header', () => {
    const f = scanText('a.pem', PLANTED.privateKey)
    expect(f.some((x) => x.rule === 'private-key')).toBe(true)
  })

  it('flags a Bearer token', () => {
    const f = scanText('a.ts', PLANTED.bearer)
    expect(f.some((x) => x.rule === 'bearer-token')).toBe(true)
  })

  it('flags URL inline basic-auth credentials', () => {
    const f = scanText('a.ts', PLANTED.urlAuth)
    expect(f.some((x) => x.rule === 'url-basic-auth')).toBe(true)
  })

  it('flags a high-entropy mixed-class string', () => {
    const f = scanText('a.ts', 'const k = "Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0Lz"')
    expect(f.some((x) => x.rule === 'high-entropy-string')).toBe(true)
  })
})

describe('scanText avoids false positives', () => {
  it('does not flag ordinary identifiers and prose', () => {
    const ordinary = [
      'export function computePermissionSummary(manifest) {',
      '  const declaredSecrets = manifest.skelm.secrets ?? []',
      '  // returns references only, never values',
      'import { runPublish } from "@skelm/package-publisher"',
      'const url = "https://registry.npmjs.org/@skelm/core"',
    ].join('\n')
    expect(scanText('a.ts', ordinary)).toEqual([])
  })

  it('does not flag a Bearer placeholder interpolation', () => {
    const f = scanText('a.ts', 'headers: { Authorization: `Bearer ${token}` }')
    expect(f).toEqual([])
  })

  it('does not flag a lockfile-style integrity hash', () => {
    const f = scanText(
      'lock.json',
      '"integrity": "sha512-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef"',
    )
    expect(f).toEqual([])
  })

  it('does not flag a repeated-character placeholder', () => {
    expect(scanText('a.ts', 'const k = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"')).toEqual([])
    expect(scanText('a.ts', 'token = "xxxxxxxxxxxxxxxxxxxxxxxxxxxx"')).toEqual([])
  })
})

describe('redaction never leaks the raw secret', () => {
  it('redactSecret masks the interior', () => {
    const raw = PLANTED.github
    const red = redactSecret(raw)
    expect(red).not.toContain(raw)
    expect(red).not.toContain(raw.slice(3, -2))
    expect(red.startsWith(raw.slice(0, 3))).toBe(true)
    expect(red.endsWith(raw.slice(-2))).toBe(true)
  })

  it('fully masks short values', () => {
    expect(redactSecret('abc')).toBe('***')
  })

  it('findings never carry the raw value anywhere', () => {
    const raw = PLANTED.github
    const interior = raw.slice(3, -2)
    const f = scanText('a.ts', `const t = "${raw}"`)
    expect(f.length).toBeGreaterThan(0)
    for (const hit of f) {
      const serialized = JSON.stringify(hit)
      expect(serialized).not.toContain(raw)
      expect(serialized).not.toContain(interior)
      expect(hit.fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/)
    }
  })
})

describe('SECRET_SCAN_RULES', () => {
  it('documents every emitted rule id', () => {
    expect(SECRET_SCAN_RULES).toContain('high-entropy-string')
    expect(SECRET_SCAN_RULES).toContain('github-token')
    expect(SECRET_SCAN_RULES).toContain('private-key')
    expect(new Set(SECRET_SCAN_RULES).size).toBe(SECRET_SCAN_RULES.length)
  })
})
