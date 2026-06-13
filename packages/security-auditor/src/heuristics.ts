// Pure detection heuristics, isolated so they can be unit-tested without the
// graph or manifest substrate. Every function here is side-effect-free and
// deterministic. The secret scanner is the one place that ever touches a real
// secret value, and it NEVER returns it — only a redacted marker.

/** A secret-value match: the file/line and a redacted preview. No raw value. */
export interface SecretMatch {
  /** 1-based line number the match was found on. */
  readonly line: number
  /** Short label for the kind of secret pattern that matched. */
  readonly kind: string
  /** Redaction-safe preview, e.g. `AKIA****************`. Never the full value. */
  readonly redacted: string
}

interface SecretPattern {
  readonly kind: string
  readonly re: RegExp
}

// High-confidence secret-VALUE signatures. These match literal values embedded
// in source, NOT references like `secrets: ['GH_TOKEN']` or `process.env.X`.
// Each pattern is anchored on a provider-specific prefix so a name like
// `GITHUB_TOKEN` (a reference) does not trip it.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-secret-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
]

/**
 * Redact a matched secret to a safe preview: keep at most the first 4
 * characters, mask the rest, and never reveal the tail. A value shorter than
 * 4 characters is fully masked.
 */
export function redactSecret(value: string): string {
  const visible = value.length > 4 ? 4 : 0
  return `${value.slice(0, visible)}${'*'.repeat(Math.max(value.length - visible, 4))}`
}

/**
 * Scan source text for embedded secret VALUES. Returns one match per finding
 * with a redacted preview — the raw value is discarded inside this function and
 * never escapes it.
 */
export function scanSecrets(source: string): readonly SecretMatch[] {
  const matches: SecretMatch[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    for (const { kind, re } of SECRET_PATTERNS) {
      re.lastIndex = 0
      for (let m = re.exec(line); m !== null; m = re.exec(line)) {
        matches.push({ line: i + 1, kind, redacted: redactSecret(m[0]) })
      }
    }
  }
  return matches
}

// Filesystem write roots that grant the step (near-)unrestricted write reach.
// `.` / `./` resolve to the project root at run time, so they are as broad as
// an explicit root path.
const BROAD_FS_ROOTS = new Set(['/', '.', './', '~', '~/', '*', '/*'])

/** True when a declared fsWrite/fsRead root is dangerously broad. */
export function isBroadFsRoot(root: string): boolean {
  const trimmed = root.trim()
  if (BROAD_FS_ROOTS.has(trimmed)) return true
  // A root that is only path separators (e.g. `//`) collapses to root.
  return /^\/+$/.test(trimmed)
}

// Executable basenames that materially widen blast radius when allowed: shells
// (arbitrary command execution), package managers (arbitrary install scripts),
// and cloud CLIs (credentialed control-plane access).
const RISKY_EXECUTABLES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'powershell',
  'pwsh',
  'cmd',
  'env',
  'eval',
  'xargs',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'pip',
  'pip3',
  'gem',
  'cargo',
  'go',
  'brew',
  'apt',
  'apt-get',
  'curl',
  'wget',
  'aws',
  'gcloud',
  'gsutil',
  'az',
  'kubectl',
  'helm',
  'doctl',
  'terraform',
  'docker',
])

/** Basename of an executable path or bare name (posix or windows separators). */
export function executableBasename(value: string): string {
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  const base = slash === -1 ? value : value.slice(slash + 1)
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

/** True when an allowed executable is in the high-risk class. */
export function isRiskyExecutable(executable: string): boolean {
  return RISKY_EXECUTABLES.has(executableBasename(executable))
}

/** True when a network host string is an egress wildcard. */
export function isWildcardHost(host: string): boolean {
  const trimmed = host.trim()
  return trimmed === '*' || trimmed.startsWith('*.') || trimmed.includes('*')
}
