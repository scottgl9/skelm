import { describe, expect, it } from 'vitest'

import { PlaywrightBrowserDriver, capturePageArtifact, extractTable } from '../src/index.js'
import { createFakePlaywright, createRecordingSink } from './fake-playwright.js'

const allowAll = () => ({ allow: true as const })

describe('capturePageArtifact', () => {
  it('navigates then persists a screenshot to the sink', async () => {
    const { launcher, calls } = createFakePlaywright({ url: 'https://ok.test/' })
    const sink = createRecordingSink()
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    const r = await capturePageArtifact(driver, sink, { url: 'https://ok.test/', name: 'p.png' })
    expect(calls.goto).toEqual(['https://ok.test/'])
    expect(sink.puts).toHaveLength(1)
    expect(r.artifact).toBe('artifact-1')
    expect(r.url).toBe('https://ok.test/')
  })

  it('does not navigate when egress denies the host', async () => {
    const { launcher, calls } = createFakePlaywright()
    const sink = createRecordingSink()
    const driver = new PlaywrightBrowserDriver({
      egress: () => ({ allow: false, reason: 'denied' }),
      launcher,
    })
    await expect(
      capturePageArtifact(driver, sink, { url: 'https://blocked.test/' }),
    ).rejects.toThrow()
    expect(calls.goto).toEqual([])
    expect(sink.puts).toEqual([])
  })
})

describe('extractTable', () => {
  it('splits text rows into cells on pipe/tab boundaries', async () => {
    const { launcher } = createFakePlaywright({
      text: { '#t': 'a | b | c\n1 | 2 | 3\n\n4 | 5 | 6' },
    })
    const driver = new PlaywrightBrowserDriver({ egress: allowAll, launcher })
    await driver.navigate('https://ok.test/')
    const { rows } = await extractTable(driver, { selector: '#t' })
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ])
  })
})
