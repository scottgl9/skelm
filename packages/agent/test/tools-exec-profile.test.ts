import { TrustEnforcer, resolvePermissions } from '@skelm/core/permissions'
import { describe, expect, it } from 'vitest'

import { BUILTIN_TOOLS, type ToolExecutionContext } from '../src/tools.js'

// The exec tool resolves allowed executables through the resolved policy.
// Executable profiles expand into allowedExecutables at resolution time (in
// core); the tool only checks `enforcer.canExec`. This proves a
// profile-granted executable is allowed and a non-granted one is denied — with
// no re-implementation of profile expansion here.

function execTool() {
  const t = BUILTIN_TOOLS.find((x) => x.name === 'exec')
  if (t === undefined) throw new Error('exec tool not found')
  return t
}

function ctxWithProfile(): ToolExecutionContext {
  // Operator defines a profile; the step references it by name. Resolution
  // expands `readonly-tools` -> ['echo'] into allowedExecutables.
  const policy = resolvePermissions(
    { allowedTools: ['*'], fsRead: ['/tmp'], fsWrite: ['/tmp'], networkEgress: 'deny' },
    { executableProfiles: ['readonly-tools'] },
    {},
    { executableProfiles: { 'readonly-tools': { executables: ['echo'] } } },
  )
  expect(policy.allowedExecutables.has('echo')).toBe(true)
  return { cwd: '/tmp', agentDefRoot: '/tmp', enforcer: new TrustEnforcer(policy) }
}

describe('exec — executable profiles', () => {
  it('allows a profile-granted executable', async () => {
    const ctx = ctxWithProfile()
    const r = await execTool().handler({ command: 'echo', args: ['hi'] }, ctx)
    expect(r.isError).toBeFalsy()
    const parsed = JSON.parse(r.content) as { exitCode: number; stdout: string }
    expect(parsed.exitCode).toBe(0)
    expect(parsed.stdout).toContain('hi')
  })

  it('denies an executable the profile did not grant', async () => {
    const ctx = ctxWithProfile()
    const r = await execTool().handler({ command: 'curl', args: ['--version'] }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Permission denied')
  })
})
