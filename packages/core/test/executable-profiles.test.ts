import { describe, expect, it } from 'vitest'
import {
  branch,
  code,
  idempotent,
  loop,
  parallel,
  pipeline,
  pipelineStep,
} from '../src/builders.js'
import { PermissionResolver } from '../src/enforcement/permission-resolver.js'
import { UnknownExecutableProfileError } from '../src/errors.js'
import { EventBus } from '../src/events.js'
import type { ExecFn } from '../src/index.js'
import {
  type ExecutableProfileDefinition,
  intersectResolvedPolicies,
  resolvePermissions,
} from '../src/permissions.js'
import { Runner, runPipeline } from '../src/runner.js'

const DEFINITIONS: Readonly<Record<string, ExecutableProfileDefinition>> = {
  linuxReadOnly: {
    description: 'read-only shell utilities',
    executables: ['ls', 'cat', 'rg'],
    tags: ['read-only'],
  },
  gitReadOnly: { executables: ['git'] },
  nodeBuild: { executables: ['node', 'pnpm'] },
}

describe('resolvePermissions — executable profile expansion', () => {
  it('expands a single profile to its executables', () => {
    const policy = resolvePermissions(
      undefined,
      { executableProfiles: ['gitReadOnly'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    expect([...policy.allowedExecutables].sort()).toEqual(['git'])
  })

  it('expands multiple profiles to the union of their executables', () => {
    const policy = resolvePermissions(
      undefined,
      { executableProfiles: ['gitReadOnly', 'nodeBuild'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    expect([...policy.allowedExecutables].sort()).toEqual(['git', 'node', 'pnpm'])
  })

  it('deduplicates executables shared by referenced profiles', () => {
    const policy = resolvePermissions(
      undefined,
      { executableProfiles: ['linuxReadOnly', 'linuxReadOnly'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    expect([...policy.allowedExecutables].sort()).toEqual(['cat', 'ls', 'rg'])
  })

  it('leaves allowedExecutables-only layers unchanged', () => {
    const policy = resolvePermissions(
      undefined,
      { allowedExecutables: ['jq'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    expect([...policy.allowedExecutables]).toEqual(['jq'])
    expect(policy.executableProfileNames?.size).toBe(0)
  })

  it('applies path/basename intersection rules between expansion and explicit list', () => {
    const policy = resolvePermissions(
      undefined,
      { executableProfiles: ['gitReadOnly'], allowedExecutables: ['/usr/bin/git'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    // Profile grants the bare name; the explicit path is the narrower entry.
    expect([...policy.allowedExecutables]).toEqual(['/usr/bin/git'])
  })

  it('expands profiles referenced from a named permission profile layer', () => {
    const policy = resolvePermissions(
      undefined,
      { profile: 'analyst' },
      { analyst: { executableProfiles: ['linuxReadOnly'] } },
      { executableProfiles: DEFINITIONS },
    )
    expect([...policy.allowedExecutables].sort()).toEqual(['cat', 'ls', 'rg'])
    expect(policy.executableProfileNames).toEqual(new Set(['linuxReadOnly']))
  })
})

describe('resolvePermissions — executableProfileNames metadata', () => {
  it('records every profile name applied across layers', () => {
    const policy = resolvePermissions(
      { executableProfiles: ['linuxReadOnly'] },
      { executableProfiles: ['gitReadOnly'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    expect(policy.executableProfileNames).toEqual(new Set(['linuxReadOnly', 'gitReadOnly']))
  })

  it('is empty when no layer references a profile', () => {
    const policy = resolvePermissions({ allowedExecutables: ['git'] }, undefined)
    expect(policy.executableProfileNames?.size).toBe(0)
  })
})

describe('intersectResolvedPolicies — executable profile metadata', () => {
  it('unions profile names while intersecting the executable sets', () => {
    const ceiling = resolvePermissions(
      undefined,
      { executableProfiles: ['linuxReadOnly'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    const child = resolvePermissions(
      undefined,
      { executableProfiles: ['gitReadOnly', 'linuxReadOnly'], allowedExecutables: ['rg', 'git'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    const bounded = intersectResolvedPolicies(ceiling, child)
    expect([...bounded.allowedExecutables]).toEqual(['rg'])
    expect(bounded.executableProfileNames).toEqual(new Set(['linuxReadOnly', 'gitReadOnly']))
  })

  it('keeps the child names under an unrestricted ceiling', () => {
    const ceiling = resolvePermissions(
      { requestUnrestricted: true },
      undefined,
      {},
      { grantUnrestricted: true },
    )
    const child = resolvePermissions(
      undefined,
      { executableProfiles: ['nodeBuild'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    const bounded = intersectResolvedPolicies(ceiling, child)
    expect(bounded.unrestricted).toBe(true)
    expect(bounded.executableProfileNames).toEqual(new Set(['nodeBuild']))
  })

  it('tolerates hand-built policies without the metadata field', () => {
    const withNames = resolvePermissions(
      undefined,
      { executableProfiles: ['gitReadOnly'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    const { executableProfileNames: _drop, ...handBuilt } = withNames
    const bounded = intersectResolvedPolicies(handBuilt, withNames)
    expect(bounded.executableProfileNames).toEqual(new Set(['gitReadOnly']))
    const reversed = intersectResolvedPolicies(withNames, handBuilt)
    expect(reversed.executableProfileNames).toEqual(new Set(['gitReadOnly']))
    const neither = intersectResolvedPolicies(handBuilt, handBuilt)
    expect(neither.executableProfileNames).toBeUndefined()
  })
})

describe('PermissionResolver — executable profile definitions', () => {
  it('threads configured definitions into resolution', () => {
    const resolver = new PermissionResolver({
      executableProfiles: DEFINITIONS,
    })
    const policy = resolver.resolve({ executableProfiles: ['nodeBuild'] })
    expect([...policy.allowedExecutables].sort()).toEqual(['node', 'pnpm'])
  })

  it('throws the typed error for unknown references', () => {
    const resolver = new PermissionResolver({ executableProfiles: DEFINITIONS })
    expect(() => resolver.resolve({ executableProfiles: ['nope'] })).toThrow(
      UnknownExecutableProfileError,
    )
  })
})

describe('run-start validation of executable profile references', () => {
  const unknownRefPipeline = () =>
    pipeline({
      id: 'wf-unknown-profile',
      steps: [
        code({
          id: 'x',
          permissions: { executableProfiles: ['notDefined'] },
          run: () => 'never',
        }),
      ],
    })

  it('runPipeline rejects before publishing any run event', async () => {
    const events = new EventBus()
    const seen: string[] = []
    events.subscribe((e) => seen.push(e.type))
    await expect(
      runPipeline(unknownRefPipeline(), undefined, { events, executableProfiles: {} }),
    ).rejects.toBeInstanceOf(UnknownExecutableProfileError)
    expect(seen).toEqual([])
  })

  it('Runner.start throws synchronously on an unknown reference', () => {
    const runner = new Runner({ executableProfiles: DEFINITIONS })
    expect(() => runner.start(unknownRefPipeline(), undefined)).toThrow(
      UnknownExecutableProfileError,
    )
  })

  it('rejects unknown references in the defaults layer', async () => {
    const wf = pipeline({ id: 'wf-defaults', steps: [code({ id: 'noop', run: () => 1 })] })
    await expect(
      runPipeline(wf, undefined, {
        defaultPermissions: { executableProfiles: ['notDefined'] },
        executableProfiles: DEFINITIONS,
      }),
    ).rejects.toBeInstanceOf(UnknownExecutableProfileError)
  })

  it('rejects unknown references in the named permission profile a step selects', async () => {
    const wf = pipeline({
      id: 'wf-named-profile',
      steps: [code({ id: 'x', permissions: { profile: 'analyst' }, run: () => 1 })],
    })
    await expect(
      runPipeline(wf, undefined, {
        permissionProfiles: { analyst: { executableProfiles: ['notDefined'] } },
        executableProfiles: DEFINITIONS,
      }),
    ).rejects.toBeInstanceOf(UnknownExecutableProfileError)
  })

  it('walks nested structural steps when validating references', async () => {
    const offending = code({
      id: 'deep',
      permissions: { executableProfiles: ['notDefined'] },
      run: () => 1,
    })
    const wf = pipeline({
      id: 'wf-nested',
      steps: [
        parallel({
          id: 'par',
          steps: [
            branch({
              id: 'br',
              on: () => 'a',
              cases: {
                a: loop({ id: 'lp', while: () => false, maxIterations: 1, step: offending }),
              },
              default: code({ id: 'noop', run: () => 1 }),
            }),
          ],
        }),
        pipelineStep({
          id: 'nested-pipe',
          pipeline: pipeline({
            id: 'inner',
            steps: [idempotent({ key: 'k', step: code({ id: 'idem', run: () => 1 }) })],
          }),
        }),
      ],
    })
    await expect(
      runPipeline(wf, undefined, { executableProfiles: DEFINITIONS }),
    ).rejects.toBeInstanceOf(UnknownExecutableProfileError)
  })

  it('runs end-to-end with a profile-expanded exec grant', async () => {
    const wf = pipeline({
      id: 'wf-profile-exec',
      steps: [
        code({
          id: 'echo',
          permissions: { executableProfiles: ['nodeBuild'] },
          run: async (ctx) =>
            await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.stdout.write("hi")'],
            }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { executableProfiles: DEFINITIONS })
    expect(run.status).toBe('completed')
    expect((run.steps[0]?.output as { stdout: string }).stdout).toBe('hi')
  })

  it('denies exec outside the referenced profile at runtime', async () => {
    const wf = pipeline({
      id: 'wf-profile-deny',
      steps: [
        code({
          id: 'git',
          permissions: { executableProfiles: ['gitReadOnly'] },
          run: async (ctx) => await (ctx.exec as ExecFn)({ command: 'node', args: ['-v'] }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { executableProfiles: DEFINITIONS })
    expect(run.status).toBe('failed')
    expect(run.error?.message).toMatch(/exec denied/)
  })
})
