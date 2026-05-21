import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore, code, pipeline } from '@skelm/core'
import { zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../../src/index.js'
import { pickFreePort } from '../utils/pick-free-port.js'

let stateDir: string
let projectRoot: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-wfzip-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-wfzip-root-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

const goodPipeline = pipeline({
  id: 'zipped',
  steps: [code({ id: 'one', run: () => ({ ok: true }) })],
})

async function bootGateway(
  overrides: { workflows?: { maxArchiveBytes?: number } } = {},
): Promise<{ gw: Gateway; base: string }> {
  const port = await pickFreePort()
  const gw = new Gateway({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
    loadWorkflow: async () => goodPipeline,
    ...(overrides.workflows !== undefined && { workflows: overrides.workflows }),
    config: { registries: { workflows: { glob: 'workflows/**/*.workflow.ts' } } },
  })
  await gw.start()
  return { gw, base: `http://127.0.0.1:${port}` }
}

const encoder = new TextEncoder()

function buildArchive(entries: Record<string, string>): Buffer {
  const obj: Record<string, Uint8Array> = {}
  for (const [name, body] of Object.entries(entries)) {
    obj[name] = encoder.encode(body)
  }
  const zipped = zipSync(obj)
  return Buffer.from(zipped)
}

function buildForm(parts: Record<string, string | { filename: string; data: Buffer }>): {
  body: Buffer
  boundary: string
} {
  const boundary = `----skelmTest${Math.random().toString(36).slice(2)}`
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(parts)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    if (typeof value === 'string') {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`))
      chunks.push(Buffer.from(`${value}\r\n`))
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\n`,
        ),
      )
      chunks.push(Buffer.from('Content-Type: application/zip\r\n\r\n'))
      chunks.push(value.data)
      chunks.push(Buffer.from('\r\n'))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), boundary }
}

async function postArchive(
  base: string,
  path: string,
  method: 'POST' | 'PUT',
  parts: Record<string, string | { filename: string; data: Buffer }>,
): Promise<Response> {
  const { body, boundary } = buildForm(parts)
  return await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
}

describe('/v1/workflows/* zip upload', () => {
  it('POST register extracts and registers a single-file workflow', async () => {
    const { gw, base } = await bootGateway()
    try {
      const archive = buildArchive({ 'wf.workflow.ts': 'export default {}' })
      const res = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'zipped-wf',
        archive: { filename: 'wf.zip', data: archive },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        registered: boolean
        workflow: { id: string; sourceKind: string; sourcePath: string }
      }
      expect(body.registered).toBe(true)
      expect(body.workflow.id).toBe('zipped-wf')
      expect(body.workflow.sourceKind).toBe('archive')
      const stats = await fs.stat(body.workflow.sourcePath)
      expect(stats.isFile()).toBe(true)
      const list = await (await fetch(`${base}/v1/workflows`)).json()
      expect(list).toEqual([
        { id: 'zipped-wf', file: body.workflow.sourcePath, source: 'registered' },
      ])
    } finally {
      await gw.stop()
    }
  })

  it('POST register against an existing extraction dir returns 409', async () => {
    const { gw, base } = await bootGateway()
    try {
      const archive = buildArchive({ 'wf.workflow.ts': 'export default {}' })
      const first = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'conflict',
        archive: { filename: 'wf.zip', data: archive },
      })
      expect(first.status).toBe(200)
      const second = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'conflict',
        archive: { filename: 'wf.zip', data: archive },
      })
      expect(second.status).toBe(409)
    } finally {
      await gw.stop()
    }
  })

  it('PUT replaces an existing archive registration atomically', async () => {
    const { gw, base } = await bootGateway()
    try {
      const first = buildArchive({
        'wf.workflow.ts': 'export default {}',
        'README.md': 'v1',
      })
      const r1 = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'replaceme',
        archive: { filename: 'wf.zip', data: first },
      })
      expect(r1.status).toBe(200)
      const second = buildArchive({ 'wf.workflow.ts': 'export default {}' })
      const r2 = await postArchive(base, '/v1/workflows/replaceme', 'PUT', {
        archive: { filename: 'wf.zip', data: second },
      })
      expect(r2.status).toBe(200)
      const { workflow } = (await r2.json()) as {
        workflow: { sourcePath: string }
      }
      const dir = join(stateDir, 'uploaded-workflows', 'replaceme')
      const names = await fs.readdir(dir)
      expect(names).toEqual(['wf.workflow.ts'])
      expect(workflow.sourcePath.startsWith(dir)).toBe(true)
    } finally {
      await gw.stop()
    }
  })

  it('rejects zip-slip entry names', async () => {
    const { gw, base } = await bootGateway()
    try {
      const archive = buildArchive({
        '../escape.workflow.ts': 'export default {}',
      })
      const res = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'evil-rel',
        archive: { filename: 'wf.zip', data: archive },
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('rejects absolute paths in entry names', async () => {
    const { gw, base } = await bootGateway()
    try {
      const archive = buildArchive({ '/etc/evil.workflow.ts': 'export default {}' })
      const res = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'evil-abs',
        archive: { filename: 'wf.zip', data: archive },
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('rejects disallowed file extensions', async () => {
    const { gw, base } = await bootGateway()
    try {
      const archive = buildArchive({
        'wf.workflow.ts': 'export default {}',
        'evil.sh': '#!/bin/sh\necho hi',
      })
      const res = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'mixed',
        archive: { filename: 'wf.zip', data: archive },
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('rejects archives exceeding the size cap', async () => {
    const { gw, base } = await bootGateway({ workflows: { maxArchiveBytes: 256 } })
    try {
      const big = 'x'.repeat(2048)
      const archive = buildArchive({ 'wf.workflow.ts': big })
      const res = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'too-big',
        archive: { filename: 'wf.zip', data: archive },
      })
      expect(res.status).toBe(413)
    } finally {
      await gw.stop()
    }
  })

  it('rejects non-zip uploads via magic-byte mismatch', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'not-a-zip',
        archive: { filename: 'wf.zip', data: Buffer.from('this is plain text, not a zip') },
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('errors when the archive contains no obvious entry workflow', async () => {
    const { gw, base } = await bootGateway()
    try {
      const archive = buildArchive({ 'README.md': '# hi' })
      const res = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'no-entry',
        archive: { filename: 'wf.zip', data: archive },
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('DELETE wipes the extraction dir for archive-sourced workflows', async () => {
    const { gw, base } = await bootGateway()
    try {
      const archive = buildArchive({ 'wf.workflow.ts': 'export default {}' })
      const r1 = await postArchive(base, '/v1/workflows/register', 'POST', {
        id: 'cleanup',
        archive: { filename: 'wf.zip', data: archive },
      })
      expect(r1.status).toBe(200)
      const dir = join(stateDir, 'uploaded-workflows', 'cleanup')
      await fs.access(dir)
      const r2 = await fetch(`${base}/v1/workflows/cleanup`, { method: 'DELETE' })
      expect(r2.status).toBe(200)
      await expect(fs.access(dir)).rejects.toBeTruthy()
    } finally {
      await gw.stop()
    }
  })
})
