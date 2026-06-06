import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

let projectDir: string
let stateDir: string
let occupied: Server | undefined

beforeEach(async () => {
  projectDir = await mkTempProject()
  stateDir = join(projectDir, 'state')
})

afterEach(async () => {
  if (occupied !== undefined) {
    await new Promise<void>((resolve) => occupied?.close(() => resolve()))
    occupied = undefined
  }
  await stopGateway(stateDir)
  await rm(projectDir, { recursive: true, force: true })
})

describe('skelm gateway start --detach — custom state dir', () => {
  it('uses the custom state dir and waits for HTTP readiness', { timeout: 30_000 }, async () => {
    const fixedPort = await listenOnFreePort()
    await writeFile(
      join(projectDir, 'skelm.config.mts'),
      `export default { server: { host: '127.0.0.1', port: ${fixedPort} } }\n`,
    )

    const start = runSkelm(['gateway', 'start', '--detach'])
    expect(start.status).toBe(0)
    expect(start.stdout).toContain('skelm gateway started (detached)')

    const set = runSkelm(['secrets', 'set', 'DETACH_READY', '--value', 'yes'])
    expect(set.status).toBe(0)
    expect(set.stdout).toContain('secret stored: DETACH_READY')

    const raw = await readFile(join(stateDir, 'secrets.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ DETACH_READY: 'yes' })
  })

  it('waits for readiness when bearer auth uses a config token', { timeout: 30_000 }, async () => {
    const fixedPort = await listenOnFreePort()
    await writeFile(
      join(projectDir, 'skelm.config.mts'),
      `export default { server: { host: '127.0.0.1', port: ${fixedPort}, auth: { mode: 'bearer' }, token: 'cfg-secret' } }\n`,
    )

    const start = runSkelm(['gateway', 'start', '--detach'])
    expect(start.status).toBe(0)
    expect(start.stdout).toContain('skelm gateway started (detached)')

    const set = runSkelm(['secrets', 'set', 'AUTH_READY', '--value', 'yes'])
    expect(set.status).toBe(0)
    expect(set.stdout).toContain('secret stored: AUTH_READY')

    const raw = await readFile(join(stateDir, 'secrets.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ AUTH_READY: 'yes' })
  })
})

function runSkelm(
  args: readonly string[],
  env: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      SKELM_STATE_DIR: stateDir,
      OPENAI_API_KEY: 'sk-test-dummy',
      FORCE_COLOR: '0',
    },
    timeout: 20_000,
  })
}

async function mkTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'skelm-cli-gw-detach-'))
}

async function listenOnFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('port pick failed'))
        return
      }
      occupied = srv
      resolve(addr.port)
    })
  })
}

async function stopGateway(dir: string): Promise<void> {
  let pid: number | undefined
  try {
    const raw = await readFile(join(dir, 'gateway.lock'), 'utf8')
    const parsed = JSON.parse(raw).pid as unknown
    if (typeof parsed === 'number') pid = parsed
  } catch {
    // best-effort cleanup
  }
  if (pid === undefined) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already exited
  }
}
