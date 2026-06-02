import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSkelmConfig } from '../src/load-config.js'

// Regression: when `skelm gateway start` is run from a directory with no
// skelm.config, loadSkelmConfig used to return DEFAULT_CONFIG verbatim — which
// carries a framework deny-all permission baseline (`networkEgress: 'deny'`,
// empty allow-lists). That baseline rode into `new Gateway({ config })` and
// became the operator's permission ceiling, so every step's resolved policy
// was intersected with deny — a workflow that explicitly granted
// `networkEgress: 'allow'` still tripped pi-sdk's assertEgressEnforceable.
// The gateway constructor's no-config fallback already strips the baseline;
// the loader must match.

describe('loadSkelmConfig (no user config found)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skelm-load-cfg-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('omits the framework deny-all permission baseline', async () => {
    const { config, source, hasExplicitDefaultPermissions } = await loadSkelmConfig({
      fromDir: dir,
    })
    expect(source).toBeNull()
    expect(hasExplicitDefaultPermissions).toBe(false)
    // The key invariant: `defaults.permissions` must not surface from the
    // loader on the no-config path. If it does, the gateway intersects every
    // step's policy with this deny-all baseline and refuses to enforce
    // anything (in-process backends fail closed on networkEgress).
    expect(config.defaults?.permissions).toBeUndefined()
  })
})
