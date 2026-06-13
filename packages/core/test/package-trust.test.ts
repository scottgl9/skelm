import { describe, expect, it } from 'vitest'

import type { WorkflowPackageManifest } from '../src/packages/manifest.js'
import {
  DEFAULT_PACKAGE_TRUST_POLICY,
  type PackageTrustPolicy,
  derivePackageTrustLevel,
  diffPackagePermissions,
  evaluatePackageTrust,
  summarizePackagePermissions,
} from '../src/packages/trust.js'

function manifest(workflows: WorkflowPackageManifest['skelm']['workflows'], extra = {}) {
  return {
    name: '@skelm/sample',
    version: '1.0.0',
    skelm: {
      apiVersion: 1 as const,
      workflows,
      ...extra,
    },
  } satisfies WorkflowPackageManifest
}

describe('derivePackageTrustLevel', () => {
  it('local directory source → local', () => {
    expect(derivePackageTrustLevel('/abs/path/to/pkg')).toBe('local')
  })

  it('local tarball source → workspace', () => {
    expect(derivePackageTrustLevel('/tmp/pkg-1.0.0.tgz')).toBe('workspace')
    expect(derivePackageTrustLevel('/tmp/pkg.tar.gz')).toBe('workspace')
  })

  it('isTarball hint overrides the extension sniff', () => {
    expect(derivePackageTrustLevel('/staged/dir', { isTarball: true })).toBe('workspace')
    expect(derivePackageTrustLevel('/x.tgz', { isTarball: false })).toBe('local')
  })

  it('registry origin wins over the source shape', () => {
    expect(derivePackageTrustLevel('pkg.tgz', { registryOrigin: 'npm' })).toBe('npm')
    expect(derivePackageTrustLevel('pkg.tgz', { registryOrigin: 'verified' })).toBe('verified')
    expect(derivePackageTrustLevel('/dir', { registryOrigin: 'private' })).toBe('private')
  })
})

describe('evaluatePackageTrust', () => {
  it('default policy: local/workspace allowed, registry levels require approval', () => {
    expect(evaluatePackageTrust('local')).toBe('allow')
    expect(evaluatePackageTrust('workspace')).toBe('allow')
    expect(evaluatePackageTrust('npm')).toBe('requires-approval')
    expect(evaluatePackageTrust('verified')).toBe('requires-approval')
    expect(evaluatePackageTrust('private')).toBe('requires-approval')
  })

  it('default-deny: a level in neither list is denied', () => {
    const policy: PackageTrustPolicy = { allow: ['local'] }
    expect(evaluatePackageTrust('local', policy)).toBe('allow')
    // workspace/npm/verified/private all absent → denied
    expect(evaluatePackageTrust('workspace', policy)).toBe('denied')
    expect(evaluatePackageTrust('npm', policy)).toBe('denied')
  })

  it('an empty policy denies every level', () => {
    const policy: PackageTrustPolicy = {}
    for (const level of ['local', 'workspace', 'npm', 'verified', 'private'] as const) {
      expect(evaluatePackageTrust(level, policy)).toBe('denied')
    }
  })

  it('allow wins when a level is in both lists', () => {
    const policy: PackageTrustPolicy = { allow: ['npm'], requireApproval: ['npm'] }
    expect(evaluatePackageTrust('npm', policy)).toBe('allow')
  })

  it('the exported default is frozen and conservative', () => {
    expect(Object.isFrozen(DEFAULT_PACKAGE_TRUST_POLICY)).toBe(true)
    expect(DEFAULT_PACKAGE_TRUST_POLICY.allow).toEqual(['local', 'workspace'])
  })
})

describe('summarizePackagePermissions', () => {
  it('unions permissions across workflows and adds manifest secrets', () => {
    const m = manifest(
      [
        {
          id: 'a',
          entry: 'a.ts',
          permissions: {
            allowedTools: ['gh.list_issues'],
            allowedExecutables: ['git'],
            allowedSecrets: ['A_TOKEN'],
            fsRead: ['/data'],
            networkEgress: { allowHosts: ['api.example.com'] },
          },
        },
        {
          id: 'b',
          entry: 'b.ts',
          permissions: {
            allowedTools: { star: true },
            fsWrite: ['/out'],
            networkEgress: 'allow',
          },
        },
      ],
      { secrets: [{ name: 'B_TOKEN' }], triggers: [{ id: 'daily', kind: 'cron' }] },
    )
    const s = summarizePackagePermissions(m)
    expect(s.tools).toContain('gh.list_issues')
    expect(s.tools).toContain('*')
    expect(s.executables).toEqual(['git'])
    expect(s.secrets).toEqual(['A_TOKEN', 'B_TOKEN'])
    expect(s.fsRead).toEqual(['/data'])
    expect(s.fsWrite).toEqual(['/out'])
    expect(s.networkAny).toBe(true)
    expect(s.networkHosts).toEqual(['api.example.com'])
    expect(s.triggers).toEqual(['daily'])
  })

  it('a manifest with no permissions yields an empty summary', () => {
    const s = summarizePackagePermissions(manifest([{ id: 'a', entry: 'a.ts' }]))
    expect(s.tools).toEqual([])
    expect(s.secrets).toEqual([])
    expect(s.networkAny).toBe(false)
  })
})

describe('diffPackagePermissions', () => {
  const base = summarizePackagePermissions(
    manifest([
      {
        id: 'a',
        entry: 'a.ts',
        permissions: {
          allowedExecutables: ['git'],
          allowedSecrets: ['A_TOKEN'],
          fsRead: ['/data'],
          networkEgress: { allowHosts: ['api.example.com'] },
        },
      },
    ]),
  )

  it('does NOT flag a same-or-narrower update', () => {
    const next = summarizePackagePermissions(
      manifest([
        {
          id: 'a',
          entry: 'a.ts',
          permissions: {
            // narrower: dropped fsRead, dropped a secret, same executables
            allowedExecutables: ['git'],
            networkEgress: { allowHosts: ['api.example.com'] },
          },
        },
      ]),
    )
    const diff = diffPackagePermissions(base, next)
    expect(diff.expanded).toBe(false)
  })

  it('flags a new executable', () => {
    const next = summarizePackagePermissions(
      manifest([{ id: 'a', entry: 'a.ts', permissions: { allowedExecutables: ['git', 'curl'] } }]),
    )
    const diff = diffPackagePermissions(base, next)
    expect(diff.expanded).toBe(true)
    expect(diff.executables).toEqual(['curl'])
  })

  it('flags a new secret', () => {
    const next = summarizePackagePermissions(
      manifest([
        { id: 'a', entry: 'a.ts', permissions: { allowedSecrets: ['A_TOKEN', 'PROD_KEY'] } },
      ]),
    )
    expect(diffPackagePermissions(base, next).secrets).toEqual(['PROD_KEY'])
  })

  it('flags a broader fs.write root', () => {
    const next = summarizePackagePermissions(
      manifest([{ id: 'a', entry: 'a.ts', permissions: { fsWrite: ['/'] } }]),
    )
    expect(diffPackagePermissions(base, next).fsWrite).toEqual(['/'])
    expect(diffPackagePermissions(base, next).expanded).toBe(true)
  })

  it('flags blanket network egress even when prior listed hosts', () => {
    const next = summarizePackagePermissions(
      manifest([{ id: 'a', entry: 'a.ts', permissions: { networkEgress: 'allow' } }]),
    )
    const diff = diffPackagePermissions(base, next)
    expect(diff.networkBroadened).toBe(true)
    expect(diff.expanded).toBe(true)
  })

  it('flags a newly-offered trigger', () => {
    const prev = summarizePackagePermissions(manifest([{ id: 'a', entry: 'a.ts' }]))
    const next = summarizePackagePermissions(
      manifest([{ id: 'a', entry: 'a.ts' }], { triggers: [{ id: 'daily', kind: 'cron' }] }),
    )
    const diff = diffPackagePermissions(prev, next)
    expect(diff.triggers).toEqual(['daily'])
    expect(diff.expanded).toBe(true)
  })

  it('adversarial: a package cannot silently gain a broader permission set', () => {
    // A "patch" release that quietly adds prod secrets, a wildcard tool, write
    // access to the whole disk, and blanket network egress MUST flag every one.
    const next = summarizePackagePermissions(
      manifest([
        {
          id: 'a',
          entry: 'a.ts',
          permissions: {
            allowedTools: ['*'],
            allowedExecutables: ['git', 'sh'],
            allowedSecrets: ['A_TOKEN', 'PROD_DEPLOY_KEY'],
            fsRead: ['/data', '/'],
            fsWrite: ['/'],
            networkEgress: 'allow',
          },
        },
      ]),
    )
    const diff = diffPackagePermissions(base, next)
    expect(diff.expanded).toBe(true)
    expect(diff.tools).toContain('*')
    expect(diff.executables).toContain('sh')
    expect(diff.secrets).toContain('PROD_DEPLOY_KEY')
    expect(diff.fsRead).toContain('/')
    expect(diff.fsWrite).toContain('/')
    expect(diff.networkBroadened).toBe(true)
  })
})
