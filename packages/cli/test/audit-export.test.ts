import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { ChainAuditWriter, Gateway } from '@skelm/gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

let stateDir: string
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-audit-'))
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  process.env.SKELM_STATE_DIR = stateDir
  process.env.SKELM_NO_AUTOSTART = '1'
  // Seed a small chain before boot so reads/exports work end-to-end.
  const w = new ChainAuditWriter(join(stateDir, 'audit.jsonl'))
  await w.write({
    actor: 'tester',
    action: 'tool.dispatch',
    runId: 'run-1',
    timestamp: '2025-01-01T00:00:00.000Z',
    details: { tool: 'demo.echo' },
  })
  await w.write({
    actor: 'tester',
    action: 'secret.resolve',
    runId: 'run-2',
    timestamp: '2025-01-02T00:00:00.000Z',
    details: { secretName: 'OPENAI_API_KEY' },
  })
})

afterEach(async () => {
  if (priorStateDir === undefined) process.env.SKELM_STATE_DIR = undefined
  else process.env.SKELM_STATE_DIR = priorStateDir
  if (priorNoAutostart === undefined) process.env.SKELM_NO_AUTOSTART = undefined
  else process.env.SKELM_NO_AUTOSTART = priorNoAutostart
  await rm(stateDir, { recursive: true, force: true })
})

describe('skelm audit export', () => {
  it('streams JSONL to stdout by default', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      const res = await invoke(['audit', 'export'])
      expect(res.exitCode).toBe(EXIT.OK)
      const lines = res.stdout.split('\n').filter((l) => l.length > 0)
      expect(lines).toHaveLength(2)
      expect((JSON.parse(lines[0] ?? '{}') as { action: string }).action).toBe('tool.dispatch')
    } finally {
      await gw.stop()
    }
  })

  it('streams CSV with a stable header and honors --since', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      const res = await invoke(['audit', 'export', '--format', 'csv', '--since', '2025-01-02'])
      expect(res.exitCode).toBe(EXIT.OK)
      const lines = res.stdout.split('\n').filter((l) => l.length > 0)
      expect(lines[0]).toBe('seq,timestamp,actor,action,runId,prevHash,entryHash,details')
      expect(lines).toHaveLength(2)
      expect(lines[1]).toContain('secret.resolve')
    } finally {
      await gw.stop()
    }
  })

  it('writes to --out and never includes a secret value', async () => {
    const gw = await startGatewayOnFreePort()
    const out = join(stateDir, 'export.jsonl')
    try {
      const res = await invoke(['audit', 'export', '--out', out])
      expect(res.exitCode).toBe(EXIT.OK)
      const body = await fs.readFile(out, 'utf8')
      expect(body).toContain('OPENAI_API_KEY')
      expect(body).not.toMatch(/sk-[A-Za-z0-9]{16,}/)
    } finally {
      await gw.stop()
    }
  })

  it('rejects an invalid --format before contacting the gateway', async () => {
    const res = await invoke(['audit', 'export', '--format', 'xml'])
    expect(res.exitCode).toBe(EXIT.CLI_ERROR)
    expect(res.stderr).toContain('jsonl or csv')
  })

  it('errors when the gateway is not running', async () => {
    const res = await invoke(['audit', 'export'])
    expect(res.exitCode).toBe(EXIT.CLI_ERROR)
    expect(res.stderr).toContain('gateway is not running')
  })
})

describe('skelm audit prune', () => {
  it('refuses without --confirm', async () => {
    const res = await invoke(['audit', 'prune', '--before', '1'])
    expect(res.exitCode).toBe(EXIT.CLI_ERROR)
    expect(res.stderr).toContain('--confirm')
  })

  it('requires --before', async () => {
    const res = await invoke(['audit', 'prune', '--confirm'])
    expect(res.exitCode).toBe(EXIT.CLI_ERROR)
    expect(res.stderr).toContain('--before')
  })

  it('prunes inclusively through --before and reports the archive path', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      const res = await invoke(['audit', 'prune', '--before', '1', '--confirm', '--json'])
      expect(res.exitCode).toBe(EXIT.OK)
      const result = JSON.parse(res.stdout) as {
        archived: number
        retained: number
        boundary: { prunedThroughSeq: number }
      }
      expect(result.archived).toBe(1)
      expect(result.retained).toBe(1)
      expect(result.boundary.prunedThroughSeq).toBe(1)

      const remaining = await new ChainAuditWriter(join(stateDir, 'audit.jsonl')).readAll()
      expect(remaining[0]?.seq).toBe(2)
      expect(remaining.some((entry) => entry.seq === 1)).toBe(false)
    } finally {
      await gw.stop()
    }
  })
})

interface InvokeResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function invoke(argv: readonly string[]): Promise<InvokeResult> {
  let stdout = ''
  let stderr = ''
  const result = await main(argv, {
    stdout: makeWritable((s) => {
      stdout += s
    }),
    stderr: makeWritable((s) => {
      stderr += s
    }),
    stdin: Readable.from([]),
  })
  return { stdout, stderr, exitCode: result.exitCode }
}

function makeWritable(append: (s: string) => void): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      append(chunk.toString())
      cb()
    },
  })
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('port pick failed'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

async function startGatewayOnFreePort(): Promise<Gateway> {
  const MAX_ATTEMPTS = 6
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      url: `http://127.0.0.1:${port}`,
    })
    try {
      await gw.start()
      return gw
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EADDRINUSE') throw err
      await gw.stop().catch(() => {})
    }
  }
  throw lastErr ?? new Error(`could not bind a free port after ${MAX_ATTEMPTS} attempts`)
}
