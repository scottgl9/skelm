import { describe, expect, it } from 'vitest'
import { TrustEnforcer, resolvePermissions } from '../../src/permissions.js'

// Path traversal coverage for TrustEnforcer.canRead/canWrite.
// Pre-fix, a root of `/data` admitted `/data/../etc/passwd` because the
// raw string comparison saw `/data/` as a prefix. Normalization collapses
// `..` segments before the boundary check.

describe('fs traversal — TrustEnforcer rejects path-escape attempts', () => {
  it('canRead denies `..` escaping the allowlisted root', () => {
    const e = new TrustEnforcer(resolvePermissions({ fsRead: ['/data'] }, undefined))
    const decision = e.canRead('/data/../etc/passwd')
    expect(decision.allow).toBe(false)
    if (!decision.allow) {
      expect(decision.dimension).toBe('fs.read')
      expect(decision.reason).toBe('path-not-in-allowlist')
    }
  })

  it('canRead denies sibling roots that string-prefix the allowlisted root', () => {
    const e = new TrustEnforcer(resolvePermissions({ fsRead: ['/data'] }, undefined))
    // `/data-evil` should not match `/data` — the boundary is `/`, not the
    // character that follows the root name.
    expect(e.canRead('/data-evil/file').allow).toBe(false)
  })

  it('canWrite denies `..` escaping the allowlisted root', () => {
    const e = new TrustEnforcer(resolvePermissions({ fsWrite: ['/var/spool'] }, undefined))
    const decision = e.canWrite('/var/spool/../../etc/passwd')
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.dimension).toBe('fs.write')
  })

  it('canRead still allows paths inside the root after normalization', () => {
    const e = new TrustEnforcer(resolvePermissions({ fsRead: ['/data'] }, undefined))
    expect(e.canRead('/data/file.txt').allow).toBe(true)
    expect(e.canRead('/data/sub/dir/file.txt').allow).toBe(true)
    // Equivalent paths via redundant separators / `.` segments resolve.
    expect(e.canRead('/data/./sub/file.txt').allow).toBe(true)
    expect(e.canRead('/data//sub//file.txt').allow).toBe(true)
  })

  it('canWrite normalizes the root itself (trailing slash, redundant segments)', () => {
    const e = new TrustEnforcer(resolvePermissions({ fsWrite: ['/var/spool/'] }, undefined))
    expect(e.canWrite('/var/spool/job.tmp').allow).toBe(true)
    expect(e.canWrite('/var/spool/../passwd').allow).toBe(false)
  })
})
