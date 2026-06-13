import { describe, expect, it } from 'vitest'
import {
  executableBasename,
  isBroadFsRoot,
  isRiskyExecutable,
  isWildcardHost,
  redactSecret,
  scanSecrets,
} from '../src/heuristics.js'

describe('redactSecret', () => {
  it('keeps at most the first 4 chars and masks the rest', () => {
    const out = redactSecret('AKIAIOSFODNN7EXAMPLE')
    expect(out.startsWith('AKIA')).toBe(true)
    expect(out).not.toContain('EXAMPLE')
    expect(out).toMatch(/^AKIA\*+$/)
  })

  it('fully masks short values', () => {
    expect(redactSecret('abc')).toBe('****')
  })
})

describe('scanSecrets', () => {
  it('flags an AWS access key id and never returns the raw value', () => {
    const value = 'AKIAIOSFODNN7EXAMPLE'
    const matches = scanSecrets(`const k = "${value}"`)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.kind).toBe('aws-access-key-id')
    expect(matches[0]?.line).toBe(1)
    expect(JSON.stringify(matches)).not.toContain(value)
  })

  it('flags a github token and a private key block', () => {
    // Token shapes assembled from fragments so no committed line holds a
    // contiguous match (which trips GitHub secret push-protection); the joined
    // runtime value still exercises the scanner.
    const src = [
      `token = ghp_${'0123456789abcdefghijklmnopqrstuvwxyz'}`,
      `-----BEGIN RSA ${'PRIVATE KEY-----'}`,
    ].join('\n')
    const kinds = scanSecrets(src).map((m) => m.kind)
    expect(kinds).toContain('github-token')
    expect(kinds).toContain('private-key-block')
  })

  it('does not flag secret REFERENCES by name', () => {
    const src = "secrets: ['GITHUB_TOKEN', 'AWS_SECRET'], env: process.env.OPENAI_KEY"
    expect(scanSecrets(src)).toHaveLength(0)
  })

  it('reports the correct line number for a multi-line source', () => {
    const src = ['line one', 'line two', `k = sk_live_${'0123456789abcdefghij'}`].join('\n')
    const matches = scanSecrets(src)
    expect(matches[0]?.line).toBe(3)
  })
})

describe('isBroadFsRoot', () => {
  it('flags root, project-root, home and wildcard roots', () => {
    for (const r of ['/', '.', './', '~', '~/', '*', '/*', '//']) {
      expect(isBroadFsRoot(r)).toBe(true)
    }
  })

  it('does not flag a scoped subdirectory', () => {
    expect(isBroadFsRoot('/var/run/app')).toBe(false)
    expect(isBroadFsRoot('./build')).toBe(false)
  })
})

describe('isRiskyExecutable', () => {
  it('flags shells, package managers, and cloud CLIs by basename', () => {
    for (const e of [
      '/bin/bash',
      'sh',
      'npm',
      'pip3',
      'aws',
      '/usr/local/bin/kubectl',
      'pwsh.exe',
    ]) {
      expect(isRiskyExecutable(e)).toBe(true)
    }
  })

  it('does not flag a benign tool', () => {
    expect(isRiskyExecutable('git')).toBe(false)
    expect(isRiskyExecutable('/usr/bin/jq')).toBe(false)
  })
})

describe('isWildcardHost', () => {
  it('flags bare and subdomain wildcards', () => {
    expect(isWildcardHost('*')).toBe(true)
    expect(isWildcardHost('*.example.com')).toBe(true)
    expect(isWildcardHost('a*b.com')).toBe(true)
  })

  it('does not flag a concrete host', () => {
    expect(isWildcardHost('api.github.com')).toBe(false)
  })
})

describe('executableBasename', () => {
  it('strips path and .exe suffix', () => {
    expect(executableBasename('/usr/bin/bash')).toBe('bash')
    expect(executableBasename('C:\\Windows\\System32\\cmd.exe')).toBe('cmd')
    expect(executableBasename('git')).toBe('git')
  })
})
