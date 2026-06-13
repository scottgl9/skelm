/**
 * Real-browser smoke test, opt-in via SKELM_LIVE_BROWSER=1.
 *
 * Drives an actual Playwright chromium against a local static HTML page served
 * on loopback. Skips cleanly (never fails) when the flag is absent or no browser
 * binary is installed, so default CI stays deterministic with no browser.
 */

import { type Server, createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PlaywrightBrowserDriver } from '../src/index.js'

const LIVE = process.env.SKELM_LIVE_BROWSER === '1'

const PAGE = `<!doctype html><html><head><title>Live Fixture</title></head>
<body><h1 id="h">hello live browser</h1>
<table id="t"><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>
</body></html>`

async function browserInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright-core')
    const b = await chromium.launch({ headless: true })
    await b.close()
    return true
  } catch {
    return false
  }
}

describe.skipIf(!LIVE)('live browser smoke (SKELM_LIVE_BROWSER=1)', () => {
  let server: Server
  let origin: string
  let hasBrowser = false

  beforeAll(async () => {
    hasBrowser = await browserInstalled()
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    origin = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()))
  })

  it('navigates and extracts text from a local fixture', async ({ skip }) => {
    if (!hasBrowser) return skip()
    const driver = new PlaywrightBrowserDriver({
      egress: (host) => ({ allow: host === '127.0.0.1' }),
      headless: true,
    })
    try {
      const nav = await driver.navigate(origin)
      expect(nav.text).toContain('Live Fixture')
      const extracted = await driver.extract({ selector: '#h' })
      expect(extracted.text).toContain('hello live browser')
    } finally {
      await driver.close()
    }
  })
})
