import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, readDiscovery } from '../src/index.js'

// Regression for the gateway-self-test cascade: an embedded / ad-hoc gateway
// (constructed WITHOUT an explicit config and WITHOUT an explicit stateDir)
// must not touch the shared default state dir (~/.skelm). e096154 isolated the
// PORTS for config-less gateways but left lockfilePath/discoveryPath pointing
// at ~/.skelm/gateway.json — so stop() (and the start() error path) called
// removeDiscovery() on the SHARED file, deleting a separately-running
// persistent gateway's discovery record while that gateway was still alive.
describe('embedded gateway discovery isolation', () => {
  let fakeHome: string
  let realHome: string | undefined

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'skelm-fakehome-'))
    realHome = process.env.HOME
    // os.homedir() resolves HOME on POSIX; point it at a temp dir so the
    // default-state-dir code path can't reach the developer's real ~/.skelm.
    process.env.HOME = fakeHome
  })

  afterEach(async () => {
    process.env.HOME = realHome
    await rm(fakeHome, { recursive: true, force: true })
  })

  it('start()/stop() of a config-less gateway must not derive paths under the default ~/.skelm', async () => {
    // Sanity: with HOME overridden, the default state dir resolves under the
    // temp home — so any leakage shows up here, not in the real ~/.skelm.
    const defaultStateDir = join(homedir(), '.skelm')
    const sharedDiscovery = join(defaultStateDir, 'gateway.json')

    // A "persistent" gateway already advertised itself in the default location.
    await fs.mkdir(defaultStateDir, { recursive: true })
    const sentinel = {
      pid: 999_999,
      url: 'http://127.0.0.1:14738',
      startedAt: new Date(0).toISOString(),
    }
    await fs.writeFile(sharedDiscovery, JSON.stringify(sentinel, null, 2))

    // Embedded/ad-hoc gateway: no config, no explicit stateDir. This is how
    // probes and embedded callers build a Gateway when they only want an
    // in-process instance — they must NOT collide with the shared state dir.
    const gw = new Gateway({})

    // It must not adopt the shared default discovery path.
    expect(gw.discoveryPath).not.toBe(sharedDiscovery)
    expect(gw.lockfilePath).not.toBe(join(defaultStateDir, 'gateway.lock'))

    await gw.start()
    await gw.stop()

    // The persistent gateway's discovery record must survive untouched.
    const survived = await readDiscovery(sharedDiscovery)
    expect(survived).not.toBeNull()
    expect(survived?.pid).toBe(sentinel.pid)
    expect(survived?.url).toBe(sentinel.url)
  })
})
