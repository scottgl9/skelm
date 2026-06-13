import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChainAuditWriter, type Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

const HELLO_MANIFEST = {
  name: '@skelm/hello',
  version: '0.1.0',
  description: 'Greets someone by name.',
  license: 'MIT',
  skelm: {
    apiVersion: 1,
    requiredSkelmVersion: '>=0.4.0',
    workflows: [
      {
        id: 'default',
        entry: 'workflows/hello.workflow.ts',
        kind: 'pipeline',
        description: 'Greets someone by name.',
      },
    ],
  },
}

const HELLO_WORKFLOW = `import { code, pipeline } from '@skelm/core'

export default pipeline({
  id: 'hello',
  steps: [code({ id: 'greet', run: () => ({ greeting: 'hello' }) })],
})
`

let projectRoot: string
let stateDir: string
let sourceDir: string
let auditPath: string
let gw: Gateway | undefined
let base: string

async function writeHelloPackage(dir: string): Promise<void> {
  await mkdir(join(dir, 'workflows'), { recursive: true })
  await writeFile(join(dir, 'skelm.package.json'), JSON.stringify(HELLO_MANIFEST, null, 2))
  await writeFile(join(dir, 'workflows', 'hello.workflow.ts'), HELLO_WORKFLOW)
}

/** Build a single 512-byte ustar header for a regular file. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644', 100, 'ascii') // mode
  header.write('0000000', 108, 'ascii') // uid
  header.write('0000000', 116, 'ascii') // gid
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write(`${Math.floor(Date.now() / 1000).toString(8)}\0`, 136, 'ascii')
  header.write('        ', 148, 'ascii') // checksum placeholder
  header.write('0', 156, 'ascii') // typeflag: regular file
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

function makeTarball(files: Array<{ name: string; data: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const file of files) {
    const body = Buffer.from(file.data, 'utf8')
    blocks.push(tarHeader(file.name, body.byteLength))
    const padded = Buffer.alloc(Math.ceil(body.byteLength / 512) * 512)
    body.copy(padded)
    blocks.push(padded)
  }
  blocks.push(Buffer.alloc(1024)) // two zero blocks: end marker
  return gzipSync(Buffer.concat(blocks))
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pkg-proj-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-pkg-state-'))
  sourceDir = await mkdtemp(join(tmpdir(), 'skelm-pkg-src-'))
  await writeHelloPackage(sourceDir)
  auditPath = join(stateDir, 'audit.jsonl')
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    enableHttp: true,
    httpPort: port,
    installSignalHandlers: false,
    watchRegistries: false,
    runStore: new MemoryRunStore(),
    auditWriter: new ChainAuditWriter(auditPath),
  }))
  gw = booted.gw
  base = booted.base
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

describe('/v1/packages', () => {
  it('install (dir) → list → info → run-resolve → remove, with audit', async () => {
    // Install from a local directory.
    const installRes = await fetch(`${base}/v1/packages/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sourceDir }),
    })
    expect(installRes.status).toBe(200)
    const installBody = await installRes.json()
    expect(installBody.installed).toMatchObject({ name: '@skelm/hello', version: '0.1.0' })
    expect(installBody.installed.integrity).toMatch(/^sha256:/)

    // List.
    const listRes = await fetch(`${base}/v1/packages`)
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json()
    expect(listBody.packages).toHaveLength(1)
    expect(listBody.packages[0]).toMatchObject({ name: '@skelm/hello', version: '0.1.0' })
    expect(listBody.packages[0].lock).toMatchObject({ resolved: sourceDir })

    // Info — URL-encoded scoped name.
    const infoRes = await fetch(`${base}/v1/packages/${encodeURIComponent('@skelm/hello')}`)
    expect(infoRes.status).toBe(200)
    const infoBody = await infoRes.json()
    expect(infoBody.manifest.name).toBe('@skelm/hello')
    expect(infoBody.versions).toEqual(['0.1.0'])
    expect(infoBody.integrity).toMatch(/^sha256:/)
    expect(infoBody.lock.integrity).toBe(infoBody.integrity)

    // Resolve a run spec to the entry file.
    const resolveRes = await fetch(`${base}/v1/packages/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: '@skelm/hello' }),
    })
    expect(resolveRes.status).toBe(200)
    const resolveBody = await resolveRes.json()
    expect(resolveBody.entryId).toBe('default')
    expect(resolveBody.file).toMatch(/hello\.workflow\.ts$/)

    // Audit recorded the install.
    const installAudit = await fetch(`${base}/audit?action=package.install`)
    expect((await installAudit.json()).entries).toHaveLength(1)

    // Remove.
    const removeRes = await fetch(`${base}/v1/packages/${encodeURIComponent('@skelm/hello')}`, {
      method: 'DELETE',
    })
    expect(removeRes.status).toBe(200)
    expect(await removeRes.json()).toMatchObject({ removed: true, name: '@skelm/hello' })
    expect((await (await fetch(`${base}/v1/packages`)).json()).packages).toHaveLength(0)

    const removeAudit = await fetch(`${base}/audit?action=package.remove`)
    expect((await removeAudit.json()).entries).toHaveLength(1)
  })

  it('install from a local .tgz tarball (package/ prefix stripped)', async () => {
    const tarball = makeTarball([
      { name: 'package/skelm.package.json', data: JSON.stringify(HELLO_MANIFEST) },
      { name: 'package/workflows/hello.workflow.ts', data: HELLO_WORKFLOW },
    ])
    const tgzPath = join(sourceDir, 'hello-0.1.0.tgz')
    await writeFile(tgzPath, tarball)

    const res = await fetch(`${base}/v1/packages/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: tgzPath }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).installed).toMatchObject({ name: '@skelm/hello', version: '0.1.0' })
  })

  it('rejects a tarball with a path-traversal entry (400, nothing installed)', async () => {
    const tarball = makeTarball([
      { name: 'package/skelm.package.json', data: JSON.stringify(HELLO_MANIFEST) },
      { name: 'package/../escape.ts', data: 'export const evil = 1' },
    ])
    const tgzPath = join(sourceDir, 'evil.tgz')
    await writeFile(tgzPath, tarball)

    const res = await fetch(`${base}/v1/packages/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: tgzPath }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).message).toMatch(/escape/i)
    // Nothing reached the store.
    expect((await (await fetch(`${base}/v1/packages`)).json()).packages).toHaveLength(0)
  })

  it('holds a remote npm tarball source pending instead of treating it as workspace trust', async () => {
    const source = 'https://registry.npmjs.org/@skelm/hello/-/hello-0.1.0.tgz'
    const res = await fetch(`${base}/v1/packages/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).message).toContain('trust level "npm"')
    expect((await (await fetch(`${base}/v1/packages`)).json()).packages).toHaveLength(0)
    const pending = await (await fetch(`${base}/audit?action=package.install.pending`)).json()
    expect(pending.entries).toHaveLength(1)
    expect(pending.entries[0]?.details).toMatchObject({
      source,
      trustLevel: 'npm',
      reason: 'trust-level-requires-approval',
    })
  })

  it('install rejects an invalid manifest with 400', async () => {
    const badDir = await mkdtemp(join(tmpdir(), 'skelm-pkg-bad-'))
    await writeFile(join(badDir, 'skelm.package.json'), JSON.stringify({ name: 'Bad Name!!' }))
    try {
      const res = await fetch(`${base}/v1/packages/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: badDir }),
      })
      expect(res.status).toBe(400)
    } finally {
      await rm(badDir, { recursive: true, force: true })
    }
  })

  it('install validation failure: missing source → 400', async () => {
    const res = await fetch(`${base}/v1/packages/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('info returns 404 for an unknown package', async () => {
    const res = await fetch(`${base}/v1/packages/${encodeURIComponent('@skelm/nope')}`)
    expect(res.status).toBe(404)
  })

  it('resolve returns 404 with available entry ids for an unknown entry', async () => {
    await fetch(`${base}/v1/packages/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sourceDir }),
    })
    const res = await fetch(`${base}/v1/packages/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: '@skelm/hello/missing' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).message).toMatch(/available: default/)
  })

  it('resolve rejects an installed package whose cached contents fail lockfile integrity', async () => {
    await fetch(`${base}/v1/packages/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sourceDir }),
    })
    const cachedWorkflow = join(
      projectRoot,
      '.skelm',
      'packages',
      '@skelm__hello',
      '0.1.0',
      'workflows',
      'hello.workflow.ts',
    )
    const original = await readFile(cachedWorkflow, 'utf8')
    await writeFile(cachedWorkflow, `${original}\n// tampered\n`)

    const res = await fetch(`${base}/v1/packages/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: '@skelm/hello' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).message).toMatch(/failed integrity verification/)
  })

  it('records the derived trust level (local dir) and surfaces it + permissions on info', async () => {
    await fetch(`${base}/v1/packages/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sourceDir }),
    })
    const info = await (
      await fetch(`${base}/v1/packages/${encodeURIComponent('@skelm/hello')}`)
    ).json()
    expect(info.trustLevel).toBe('local')
    expect(info.permissions).toBeDefined()
    expect(info.lock.trustLevel).toBe('local')
  })

  it('refuses a package whose trust level the policy denies (403 + audit)', async () => {
    const projRoot = await mkdtemp(join(tmpdir(), 'skelm-pkg-deny-proj-'))
    const stDir = await mkdtemp(join(tmpdir(), 'skelm-pkg-deny-state-'))
    const audit = join(stDir, 'audit.jsonl')
    const booted = await bootGatewayWithRetry((port) => ({
      stateDir: stDir,
      projectRoot: projRoot,
      enableHttp: true,
      httpPort: port,
      installSignalHandlers: false,
      watchRegistries: false,
      runStore: new MemoryRunStore(),
      auditWriter: new ChainAuditWriter(audit),
      // Policy denies the `local` level outright.
      config: {
        server: { host: '127.0.0.1', port, auth: { mode: 'none' } },
        defaults: { packageTrust: { allow: ['npm'] } },
      },
    }))
    try {
      const res = await fetch(`${booted.base}/v1/packages/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: sourceDir }),
      })
      expect(res.status).toBe(403)
      expect((await res.json()).message).toMatch(/trust policy denies/i)
      // Nothing reached the store.
      expect((await (await fetch(`${booted.base}/v1/packages`)).json()).packages).toHaveLength(0)
      const refused = await fetch(`${booted.base}/audit?action=package.install.refused`)
      expect((await refused.json()).entries).toHaveLength(1)
    } finally {
      await booted.gw.stop()
      await rm(projRoot, { recursive: true, force: true })
      await rm(stDir, { recursive: true, force: true })
    }
  })

  it('holds a require-approval package pending without approve (409 + audit), installs with approve', async () => {
    const projRoot = await mkdtemp(join(tmpdir(), 'skelm-pkg-pend-proj-'))
    const stDir = await mkdtemp(join(tmpdir(), 'skelm-pkg-pend-state-'))
    const audit = join(stDir, 'audit.jsonl')
    const booted = await bootGatewayWithRetry((port) => ({
      stateDir: stDir,
      projectRoot: projRoot,
      enableHttp: true,
      httpPort: port,
      installSignalHandlers: false,
      watchRegistries: false,
      runStore: new MemoryRunStore(),
      auditWriter: new ChainAuditWriter(audit),
      // `local` (directory) requires approval here.
      config: {
        server: { host: '127.0.0.1', port, auth: { mode: 'none' } },
        defaults: { packageTrust: { allow: ['npm'], requireApproval: ['local'] } },
      },
    }))
    try {
      const pending = await fetch(`${booted.base}/v1/packages/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: sourceDir }),
      })
      expect(pending.status).toBe(409)
      expect((await pending.json()).message).toMatch(/requires explicit approval/i)
      expect((await (await fetch(`${booted.base}/v1/packages`)).json()).packages).toHaveLength(0)
      const pend = await fetch(`${booted.base}/audit?action=package.install.pending`)
      expect((await pend.json()).entries).toHaveLength(1)

      // With approve:true it installs.
      const approved = await fetch(`${booted.base}/v1/packages/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: sourceDir, approve: true }),
      })
      expect(approved.status).toBe(200)
      expect((await (await fetch(`${booted.base}/v1/packages`)).json()).packages).toHaveLength(1)
    } finally {
      await booted.gw.stop()
      await rm(projRoot, { recursive: true, force: true })
      await rm(stDir, { recursive: true, force: true })
    }
  })

  it('flags an update that expands the requested permission surface (409 + audit), proceeds with approve', async () => {
    // Install v1 with no requested permissions.
    const v1 = await mkdtemp(join(tmpdir(), 'skelm-pkg-v1-'))
    await mkdir(join(v1, 'workflows'), { recursive: true })
    await writeFile(
      join(v1, 'skelm.package.json'),
      JSON.stringify({
        name: '@skelm/grow',
        version: '1.0.0',
        skelm: {
          apiVersion: 1,
          workflows: [{ id: 'default', entry: 'workflows/main.ts' }],
        },
      }),
    )
    await writeFile(join(v1, 'workflows', 'main.ts'), HELLO_WORKFLOW)

    // v2 keeps the same version dir contents but broadens permissions (and a
    // new secret) — the adversarial silent-widening case.
    const v2 = await mkdtemp(join(tmpdir(), 'skelm-pkg-v2-'))
    await mkdir(join(v2, 'workflows'), { recursive: true })
    await writeFile(
      join(v2, 'skelm.package.json'),
      JSON.stringify({
        name: '@skelm/grow',
        version: '2.0.0',
        skelm: {
          apiVersion: 1,
          workflows: [
            {
              id: 'default',
              entry: 'workflows/main.ts',
              permissions: { allowedExecutables: ['sh'], networkEgress: 'allow' },
            },
          ],
          secrets: [{ name: 'PROD_KEY' }],
        },
      }),
    )
    await writeFile(join(v2, 'workflows', 'main.ts'), HELLO_WORKFLOW)

    try {
      const i1 = await fetch(`${base}/v1/packages/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: v1 }),
      })
      expect(i1.status).toBe(200)

      // The expanding update is flagged and held.
      const flagged = await fetch(`${base}/v1/packages/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: v2 }),
      })
      expect(flagged.status).toBe(409)
      expect((await flagged.json()).message).toMatch(/expands its requested permissions/i)
      const flagAudit = await fetch(`${base}/audit?action=package.update.flagged`)
      const flagEntries = (await flagAudit.json()).entries
      expect(flagEntries).toHaveLength(1)
      expect(flagEntries[0].details.expansion.executables).toContain('sh')
      expect(flagEntries[0].details.expansion.secrets).toContain('PROD_KEY')
      expect(flagEntries[0].details.expansion.networkBroadened).toBe(true)

      // With approve:true the expanding update proceeds and is surfaced.
      const approved = await fetch(`${base}/v1/packages/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: v2, approve: true }),
      })
      expect(approved.status).toBe(200)
      const body = await approved.json()
      expect(body.installed.expansion.expanded).toBe(true)
    } finally {
      await rm(v1, { recursive: true, force: true })
      await rm(v2, { recursive: true, force: true })
    }
  })

  it('fails closed when the lock baseline version was evicted from the cache', async () => {
    // Adversarial: the lockfile records a version whose cached manifest is gone,
    // so the update diff has no baseline. The gate must still fire (diff against
    // the empty surface) rather than silently widening permissions.
    const mkPkg = async (version: string, perms?: Record<string, unknown>): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), `skelm-pkg-${version}-`))
      await mkdir(join(dir, 'workflows'), { recursive: true })
      await writeFile(
        join(dir, 'skelm.package.json'),
        JSON.stringify({
          name: '@skelm/grow',
          version,
          skelm: {
            apiVersion: 1,
            workflows: [
              {
                id: 'default',
                entry: 'workflows/main.ts',
                ...(perms ? { permissions: perms } : {}),
              },
            ],
          },
        }),
      )
      await writeFile(join(dir, 'workflows', 'main.ts'), HELLO_WORKFLOW)
      return dir
    }
    const v1 = await mkPkg('1.0.0')
    const v2 = await mkPkg('2.0.0', { allowedExecutables: ['sh'], networkEgress: 'allow' })
    const v3 = await mkPkg('3.0.0', { allowedExecutables: ['bash'], networkEgress: 'allow' })
    try {
      // Install v1 (no perms), then approve v2 (broad). Lock now records 2.0.0;
      // cache holds both 1.0.0 and 2.0.0.
      expect(
        (
          await fetch(`${base}/v1/packages/install`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: v1 }),
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await fetch(`${base}/v1/packages/install`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: v2, approve: true }),
          })
        ).status,
      ).toBe(200)

      // Evict the lock-recorded version's cache files. 1.0.0 remains installed,
      // so the lockfile entry is KEPT — still pointing at the now-absent 2.0.0.
      const del = await fetch(
        `${base}/v1/packages/${encodeURIComponent('@skelm/grow')}?version=2.0.0`,
        { method: 'DELETE' },
      )
      expect(del.status).toBe(200)

      // The expanding update must be held even though its baseline is gone.
      const flagged = await fetch(`${base}/v1/packages/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: v3 }),
      })
      expect(flagged.status).toBe(409)
      expect((await flagged.json()).message).toMatch(/expands its requested permissions/i)
      const flagEntries = (
        await (await fetch(`${base}/audit?action=package.update.flagged`)).json()
      ).entries
      expect(flagEntries.at(-1).details.baselineKnown).toBe(false)
      expect(flagEntries.at(-1).details.expansion.executables).toContain('bash')

      // With approve it proceeds.
      expect(
        (
          await fetch(`${base}/v1/packages/install`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: v3, approve: true }),
          })
        ).status,
      ).toBe(200)
    } finally {
      await rm(v1, { recursive: true, force: true })
      await rm(v2, { recursive: true, force: true })
      await rm(v3, { recursive: true, force: true })
    }
  })

  it('does NOT flag a same-or-narrower update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-pkg-same-'))
    await mkdir(join(dir, 'workflows'), { recursive: true })
    const writeManifest = async (version: string) => {
      await writeFile(
        join(dir, 'skelm.package.json'),
        JSON.stringify({
          name: '@skelm/stable',
          version,
          skelm: {
            apiVersion: 1,
            workflows: [
              {
                id: 'default',
                entry: 'workflows/main.ts',
                permissions: { allowedExecutables: ['git'] },
              },
            ],
          },
        }),
      )
    }
    await writeFile(join(dir, 'workflows', 'main.ts'), HELLO_WORKFLOW)
    try {
      await writeManifest('1.0.0')
      expect(
        (
          await fetch(`${base}/v1/packages/install`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: dir }),
          })
        ).status,
      ).toBe(200)
      // Same permission set, new version — no expansion, no approval needed.
      await writeManifest('1.1.0')
      const update = await fetch(`${base}/v1/packages/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: dir }),
      })
      expect(update.status).toBe(200)
      expect((await update.json()).installed.expansion).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects unauthenticated requests with 401 when bearer auth is on', async () => {
    const authState = await mkdtemp(join(tmpdir(), 'skelm-pkg-auth-'))
    const authProj = await mkdtemp(join(tmpdir(), 'skelm-pkg-auth-proj-'))
    const booted = await bootGatewayWithRetry((port) => ({
      stateDir: authState,
      projectRoot: authProj,
      enableHttp: true,
      httpPort: port,
      installSignalHandlers: false,
      watchRegistries: false,
      token: 'sekret',
      runStore: new MemoryRunStore(),
      config: { server: { host: '127.0.0.1', port, auth: { mode: 'bearer' } } },
    }))
    try {
      const res = await fetch(`${booted.base}/v1/packages`)
      expect(res.status).toBe(401)
    } finally {
      await booted.gw.stop()
      await rm(authState, { recursive: true, force: true })
      await rm(authProj, { recursive: true, force: true })
    }
  })
})
