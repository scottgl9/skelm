import { describe, expect, it, vi } from 'vitest'

import { PlaywrightBrowserDriver } from '../src/index.js'
import { createFakePlaywright, createRecordingSink } from './fake-playwright.js'

const allowAll = () => ({ allow: true as const })
const SECRET = 'super-secret-token-9f3a'

describe('no secret leak into artifacts or logs', () => {
  it('typed credentials never appear in a persisted screenshot artifact', async () => {
    const { launcher } = createFakePlaywright({ screenshotBytes: new Uint8Array([1, 2, 3]) })
    const sink = createRecordingSink()
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/login')
    await driver.type({ selector: '#password', text: SECRET })
    await driver.captureScreenshotArtifact(sink, { name: 'login.png' })
    for (const put of sink.puts) {
      expect(put.content).not.toContain(SECRET)
      expect(put.name).not.toContain(SECRET)
    }
  })

  it('the egress error message names only the host, never a secret', async () => {
    const { launcher } = createFakePlaywright()
    const driver = new PlaywrightBrowserDriver({
      egress: () => ({ allow: false, reason: 'host not in allowlist' }),
      launcher,
    })
    const err = await driver.navigate(`https://blocked.test/?t=${SECRET}`).catch((e) => e as Error)
    expect(err.message).not.toContain(SECRET)
    expect(err.message).toContain('blocked.test')
  })

  it('driver writes nothing to console during normal operation', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { launcher } = createFakePlaywright()
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/')
    await driver.type({ selector: '#p', text: SECRET })
    await driver.extract({})
    expect(spy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
    spy.mockRestore()
    errSpy.mockRestore()
  })
})
