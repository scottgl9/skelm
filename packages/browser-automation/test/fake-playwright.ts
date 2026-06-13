/**
 * In-memory fake Playwright surface for deterministic unit tests. No real
 * browser process; every method records calls so tests can assert the driver
 * mapped each op to the right Playwright call.
 */

import type { PlaywrightLauncher, PwBrowser, PwContext, PwLocator, PwPage } from '../src/index.js'
import type { PwFrame } from '../src/playwright-types.js'

export interface FakeCalls {
  goto: string[]
  click: string[]
  fill: { selector: string; value: string }[]
  innerText: string[]
  screenshot: number
  locatorScreenshot: string[]
  closed: boolean
}

export interface FakeOptions {
  /** Text returned by innerText/locator.innerText, keyed by selector ('body' default). */
  text?: Record<string, string>
  title?: string
  url?: string
  gotoUrl?: string
  clickUrl?: string
  /** Bytes screenshot returns (default a small PNG-ish buffer). */
  screenshotBytes?: Uint8Array
}

export function createFakePlaywright(opts: FakeOptions = {}): {
  launcher: PlaywrightLauncher
  calls: FakeCalls
} {
  const calls: FakeCalls = {
    goto: [],
    click: [],
    fill: [],
    innerText: [],
    screenshot: 0,
    locatorScreenshot: [],
    closed: false,
  }
  const bytes = opts.screenshotBytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const textFor = (selector: string): string => opts.text?.[selector] ?? opts.text?.body ?? ''
  let currentUrl = opts.url ?? 'https://example.test/'
  const listeners: Array<(frame: PwFrame) => void> = []
  const emitNavigation = () => {
    const frame: PwFrame = { url: () => currentUrl }
    for (const listener of listeners) listener(frame)
  }

  const page: PwPage & { locator(selector: string): PwLocator } = {
    async goto(url: string) {
      calls.goto.push(url)
      currentUrl = opts.gotoUrl ?? opts.url ?? url
      emitNavigation()
      return undefined
    },
    async click(selector: string) {
      calls.click.push(selector)
      if (opts.clickUrl !== undefined) {
        currentUrl = opts.clickUrl
        emitNavigation()
      }
    },
    async fill(selector: string, value: string) {
      calls.fill.push({ selector, value })
    },
    async title() {
      return opts.title ?? 'Fake Title'
    },
    url() {
      return currentUrl
    },
    on(event, listener) {
      if (event === 'framenavigated') listeners.push(listener)
    },
    async innerText(selector: string) {
      calls.innerText.push(selector)
      return textFor(selector)
    },
    locator(selector: string): PwLocator {
      return {
        async innerText() {
          return textFor(selector)
        },
        async screenshot() {
          calls.locatorScreenshot.push(selector)
          return bytes
        },
      } as PwLocator & { screenshot(): Promise<Uint8Array> }
    },
    async screenshot() {
      calls.screenshot++
      return bytes
    },
  }

  const context: PwContext = {
    async newPage() {
      return page
    },
  }
  const browser: PwBrowser = {
    async newContext() {
      return context
    },
    async close() {
      calls.closed = true
    },
  }
  const launcher: PlaywrightLauncher = async () => browser
  return { launcher, calls }
}

/** An artifact sink that records every put and hands back deterministic ids. */
export function createRecordingSink(): {
  put: (input: {
    name: string
    content: string
    contentType?: string
    encoding?: 'utf-8' | 'base64'
  }) => Promise<{ id: string }>
  puts: { name: string; content: string; contentType?: string; encoding?: string }[]
} {
  const puts: { name: string; content: string; contentType?: string; encoding?: string }[] = []
  return {
    puts,
    async put(input) {
      puts.push(input)
      return { id: `artifact-${puts.length}` }
    },
  }
}
