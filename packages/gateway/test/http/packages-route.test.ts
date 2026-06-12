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
