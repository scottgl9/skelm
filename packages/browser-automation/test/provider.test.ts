import { describe, expect, it } from 'vitest'

import { PlaywrightBrowserProvider } from '../src/index.js'
import { createFakePlaywright } from './fake-playwright.js'

const allowAll = () => ({ allow: true as const })

describe('PlaywrightBrowserProvider', () => {
  it('is a registry-level browser provider with no credential refs', () => {
    const { launcher } = createFakePlaywright()
    const p = new PlaywrightBrowserProvider({ egress: allowAll, launcher })
    expect(p.category).toBe('browser')
    expect(p.id).toBe('playwright')
    expect(p.credentials).toEqual([])
    expect(p.headless).toBe(true)
  })

  it('exposes a driver satisfying the action surface', async () => {
    const { launcher, calls } = createFakePlaywright({ url: 'https://ok.test/' })
    const p = new PlaywrightBrowserProvider({ egress: allowAll, launcher })
    const r = await p.driver.navigate('https://ok.test/')
    expect(r.url).toBe('https://ok.test/')
    expect(calls.goto).toEqual(['https://ok.test/'])
  })

  it('health resolves playwright-core without launching a browser', async () => {
    const { launcher, calls } = createFakePlaywright()
    const p = new PlaywrightBrowserProvider({ egress: allowAll, launcher })
    const h = await p.health()
    expect(h.healthy).toBe(true)
    expect(h.status).toBe('ok')
    expect(calls.goto).toEqual([])
  })
})
