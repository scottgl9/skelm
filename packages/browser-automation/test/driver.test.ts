import { describe, expect, it } from 'vitest'

import {
  BrowserEgressError,
  BrowserNotNavigatedError,
  PlaywrightBrowserDriver,
} from '../src/index.js'
import { createFakePlaywright, createRecordingSink } from './fake-playwright.js'

const allowAll = () => ({ allow: true as const })

describe('PlaywrightBrowserDriver op mapping', () => {
  it('navigate maps to page.goto after egress allow and returns title/url', async () => {
    const { launcher, calls } = createFakePlaywright({ title: 'Hello', url: 'https://ok.test/' })
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    const r = await driver.navigate('https://ok.test/page')
    expect(calls.goto).toEqual(['https://ok.test/page'])
    expect(r).toEqual({ text: 'Hello', url: 'https://ok.test/' })
  })

  it('click and type map to page.click / page.fill', async () => {
    const { launcher, calls } = createFakePlaywright()
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/')
    await driver.click('#go')
    await driver.type({ selector: '#name', text: 'skelm' })
    expect(calls.click).toEqual(['#go'])
    expect(calls.fill).toEqual([{ selector: '#name', value: 'skelm' }])
  })

  it('click returns the new URL when navigation stays within the allowlist', async () => {
    const { launcher } = createFakePlaywright({
      url: 'https://ok.test/',
      clickUrl: 'https://docs.ok.test/next',
    })
    const driver = new PlaywrightBrowserDriver({
      egress: (host) => ({ allow: host === 'ok.test' || host.endsWith('.ok.test') }),
      launcher,
    })
    await driver.navigate('https://ok.test/')
    const result = await driver.click('#go')
    expect(result.url).toBe('https://docs.ok.test/next')
  })

  it('extract returns normalized body text', async () => {
    const { launcher } = createFakePlaywright({ text: { body: '  line one  \n\n  line two  \n' } })
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/')
    const r = await driver.extract({})
    expect(r.text).toBe('line one\nline two')
  })

  it('extract honors a selector', async () => {
    const { launcher, calls } = createFakePlaywright({ text: { '#main': 'scoped' } })
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/')
    const r = await driver.extract({ selector: '#main' })
    expect(calls.innerText).toContain('#main')
    expect(r.text).toBe('scoped')
  })

  it('screenshot returns base64 bytes inline only via the raw contract method', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const { launcher, calls } = createFakePlaywright({ screenshotBytes: bytes })
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/')
    const shot = await driver.screenshot()
    expect(calls.screenshot).toBe(1)
    expect(shot.contentType).toBe('image/png')
    expect(shot.data).toBe(Buffer.from(bytes).toString('base64'))
  })
})

describe('egress enforcement', () => {
  it('denies navigation BEFORE any playwright call', async () => {
    const { launcher, calls } = createFakePlaywright()
    const driver = new PlaywrightBrowserDriver({
      egress: (host) => ({ allow: false, reason: `host ${host} not allowed` }),
      launcher,
    })
    await expect(driver.navigate('https://blocked.test/')).rejects.toBeInstanceOf(
      BrowserEgressError,
    )
    expect(calls.goto).toEqual([])
  })

  it('rejects a malformed URL as an egress error', async () => {
    const { launcher } = createFakePlaywright()
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await expect(driver.navigate('not-a-url')).rejects.toBeInstanceOf(BrowserEgressError)
  })

  it('denies navigation triggered by click when the destination host is blocked', async () => {
    const { launcher, calls } = createFakePlaywright({
      url: 'https://ok.test/',
      clickUrl: 'https://blocked.test/away',
    })
    const driver = new PlaywrightBrowserDriver({
      egress: (host) => ({ allow: host === 'ok.test' }),
      launcher,
    })
    await driver.navigate('https://ok.test/')
    await expect(driver.click('#go')).rejects.toBeInstanceOf(BrowserEgressError)
    expect(calls.click).toEqual(['#go'])
    expect(calls.closed).toBe(true)
    await expect(driver.extract({})).rejects.toBeInstanceOf(BrowserNotNavigatedError)
  })

  it('actions before navigate throw BrowserNotNavigatedError', async () => {
    const { launcher } = createFakePlaywright()
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await expect(driver.click('#x')).rejects.toBeInstanceOf(BrowserNotNavigatedError)
  })
})

describe('screenshot artifact sink', () => {
  it('captureScreenshotArtifact routes bytes to the sink and returns only a ref', async () => {
    const { launcher } = createFakePlaywright({ screenshotBytes: new Uint8Array([9, 9]) })
    const sink = createRecordingSink()
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/')
    const result = await driver.captureScreenshotArtifact(sink, { name: 'shot.png' })
    expect(result.artifact).toBe('artifact-1')
    expect(result.contentType).toBe('image/png')
    expect(sink.puts).toHaveLength(1)
    expect(sink.puts[0]).toMatchObject({
      name: 'shot.png',
      encoding: 'base64',
      contentType: 'image/png',
    })
    // The returned object exposes no inline image bytes.
    expect(JSON.stringify(result)).not.toContain(Buffer.from([9, 9]).toString('base64'))
  })

  it('element-scoped capture uses the locator screenshot path', async () => {
    const { launcher, calls } = createFakePlaywright()
    const sink = createRecordingSink()
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/')
    await driver.captureScreenshotArtifact(sink, { selector: '#hero' })
    expect(calls.locatorScreenshot).toEqual(['#hero'])
    expect(calls.screenshot).toBe(0)
  })
})

describe('lifecycle', () => {
  it('close shuts down the browser', async () => {
    const { launcher, calls } = createFakePlaywright()
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/')
    await driver.close()
    expect(calls.closed).toBe(true)
  })
})
