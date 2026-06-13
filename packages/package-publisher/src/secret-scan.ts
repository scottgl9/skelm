// Secret scanner for workflow-package contents. The whole point is to stop a
// package from shipping a real credential, so a single confident hit FAILS the
// publish. A matched value is NEVER returned or logged verbatim; every finding
// carries only a redacted fingerprint (kind + masked sample + sha256 prefix).

import { createHash } from 'node:crypto'

/** A single likely-secret finding. Carries no raw secret value. */
export interface SecretFinding {
  /** Package-relative posix path of the file the match was found in. */
  file: string
  /** 1-based line number of the match. */
  line: number
  /** Which heuristic fired. */
  rule: string
  /** Redacted sample: first/last few chars with the middle masked. */
  redacted: string
  /** `sha256:<first 12 hex>` of the raw match — stable id, not reversible. */
  fingerprint: string
}

interface PatternRule {
  rule: string
  re: RegExp
  /** Which capture group holds the secret value (default 0 = whole match). */
  group?: number
}

// Known token shapes. Anchored on distinctive prefixes so ordinary code does
// not match. Each rule documents what it targets.
const PATTERN_RULES: readonly PatternRule[] = [
  // AWS access key id, e.g. AKIA + 16 base32 chars.
  { rule: 'aws-access-key-id', re: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16})\b/g, group: 1 },
  // AWS secret access key assigned to an `aws_secret_access_key`-ish field.
  {
    rule: 'aws-secret-access-key',
    re: /aws_?secret_?access_?key["'\s:=]+([A-Za-z0-9/+]{40})\b/gi,
    group: 1,
  },
  // GitHub personal-access / app / OAuth tokens (ghp_, gho_, ghu_, ghs_, ghr_).
  { rule: 'github-token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/g, group: 1 },
  // GitHub fine-grained PAT.
  { rule: 'github-fine-grained-token', re: /\b(github_pat_[A-Za-z0-9_]{22,})\b/g, group: 1 },
  // Slack tokens (bot/user/app/legacy): xox[baprs]-...
  { rule: 'slack-token', re: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g, group: 1 },
  // Google API key.
  { rule: 'google-api-key', re: /\b(AIza[0-9A-Za-z_-]{35})\b/g, group: 1 },
  // Stripe live secret key.
  { rule: 'stripe-secret-key', re: /\b(sk_live_[0-9A-Za-z]{16,})\b/g, group: 1 },
  // OpenAI / Anthropic style provider keys.
  { rule: 'openai-key', re: /\b(sk-[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  { rule: 'anthropic-key', re: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  // HTTP Authorization: Bearer <token> — only flags long opaque tokens, not
  // `Bearer ${var}` interpolations or short placeholders.
  { rule: 'bearer-token', re: /\bBearer\s+([A-Za-z0-9._~+/-]{24,}={0,2})\b/g, group: 1 },
  // PEM private-key header — any kind.
  {
    rule: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    group: 0,
  },
  // URL with inline basic-auth credentials: scheme://user:pass@host
  { rule: 'url-basic-auth', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/:@]{6,})@/gi, group: 1 },
]

const ENTROPY_RULE = 'high-entropy-string'
// Quoted or assigned long token-ish runs become entropy candidates.
const ENTROPY_CANDIDATE_RE = /[A-Za-z0-9_\-+/=]{24,}/g
const ENTROPY_THRESHOLD = 4.0

// Things that look long-and-random but are not secrets: hashes already meant to
// be public, lockfile integrity hashes, base64-looking import maps, etc. Lines
// that are clearly such are skipped to keep false positives down.
const ENTROPY_SKIP_LINE = /sha\d{3}[-:]|integrity|@skelm\/|\bimport\b|\brequire\b|https?:\/\//i

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const c of counts.values()) {
    const p = c / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

function fingerprint(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
}

/**
 * Redact a raw secret to a non-reversible sample: keep up to 3 leading and 2
 * trailing chars, mask the middle. Short values are fully masked. The returned
 * string never contains the secret's interior bytes.
 */
export function redactSecret(raw: string): string {
  if (raw.length <= 8) return '*'.repeat(raw.length)
  const head = raw.slice(0, 3)
  const tail = raw.slice(-2)
  return `${head}${'*'.repeat(Math.min(raw.length - 5, 12))}${tail}`
}

function looksLikePlaceholder(value: string): boolean {
  // Skip obvious template/interpolation and repeated-char placeholders.
  if (/\$\{|\{\{|<[a-z_]+>|xxxx|XXXX|example|placeholder|redacted|your[-_]?/.test(value)) {
    return true
  }
  // A run of a single repeated character (e.g. AAAA…, 0000…) is not a secret.
  return new Set(value).size <= 2
}

/**
 * Scan one file's text for likely secrets. Pure and synchronous; returns
 * findings (possibly empty). `file` is recorded on each finding for reporting.
 */
export function scanText(file: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)

  const push = (lineIdx: number, rule: string, raw: string): void => {
    const key = `${rule}\0${raw}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({
      file,
      line: lineIdx + 1,
      rule,
      redacted: redactSecret(raw),
      fingerprint: fingerprint(raw),
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    for (const { rule, re, group } of PATTERN_RULES) {
      re.lastIndex = 0
      let m: RegExpExecArray | null = re.exec(line)
      while (m !== null) {
        const raw = m[group ?? 0] ?? m[0]
        if (raw && !looksLikePlaceholder(raw)) push(i, rule, raw)
        m = re.exec(line)
      }
    }

    if (ENTROPY_SKIP_LINE.test(line)) continue
    ENTROPY_CANDIDATE_RE.lastIndex = 0
    let cand: RegExpExecArray | null = ENTROPY_CANDIDATE_RE.exec(line)
    while (cand !== null) {
      const value = cand[0]
      if (
        !looksLikePlaceholder(value) &&
        shannonEntropy(value) >= ENTROPY_THRESHOLD &&
        // Require mixed character classes — pure lowercase identifiers rarely
        // clear the threshold, but be explicit to avoid flagging long names.
        /[A-Z]/.test(value) &&
        /[a-z]/.test(value) &&
        /[0-9]/.test(value)
      ) {
        push(i, ENTROPY_RULE, value)
      }
      cand = ENTROPY_CANDIDATE_RE.exec(line)
    }
  }

  return findings
}

/** The rule ids this scanner can emit, for documentation and tests. */
export const SECRET_SCAN_RULES: readonly string[] = [
  ...PATTERN_RULES.map((r) => r.rule),
  ENTROPY_RULE,
]
