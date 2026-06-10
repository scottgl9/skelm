import { resolvePermissions } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { buildOpencodeToolsFromPolicy } from '../src/client.js'

// opencode's built-in webSearch tool runs in-process and does not traverse the
// gateway egress proxy, so a per-host `allowHosts` policy cannot be enforced on
// it. It must therefore be enabled only under a blanket `networkEgress: 'allow'`
// — matching the codex mapper, which disables web_search for anything narrower.

const basePerms = {
  // Non-star so buildOpencodeToolsFromPolicy emits the explicit tool map
  // (a star policy short-circuits to opencode's defaults).
  allowedTools: [] as string[],
  allowedMcpServers: [],
  fsRead: [],
  fsWrite: [],
  allowedExecutables: [],
  allowedSkills: [],
}

function toolsFor(networkEgress: 'allow' | 'deny' | { allowHosts: string[] }) {
  const policy = resolvePermissions(undefined, { ...basePerms, networkEgress })
  return buildOpencodeToolsFromPolicy(policy)
}

describe('buildOpencodeToolsFromPolicy — webSearch egress gating', () => {
  it('enables webSearch under a blanket networkEgress: "allow"', () => {
    expect(toolsFor('allow').webSearch).toBe(true)
  })

  it('disables webSearch under networkEgress: "deny"', () => {
    expect(toolsFor('deny').webSearch).toBe(false)
  })

  it('disables webSearch under an allowHosts policy (it bypasses the egress proxy)', () => {
    // Regression: previously `networkEgress !== 'deny'` enabled the in-process
    // web tool for an allowHosts policy, bypassing the per-host allowlist.
    expect(toolsFor({ allowHosts: ['api.example.com'] }).webSearch).toBe(false)
  })
})
