import { describe, expect, it } from 'vitest'
import { formatStartGuidanceMessage } from '../src/gateway.js'

// `skelm gateway start` (no --foreground, no managed unit) must not silently run
// in the foreground. It prints guidance pointing at the two supported ways to
// run the gateway. Pinned as a pure contract so we don't have to spawn anything.
describe('formatStartGuidanceMessage', () => {
  it('names both install and --foreground when a service manager is available', () => {
    const msg = formatStartGuidanceMessage({ canInstall: true })
    expect(msg).toContain('skelm gateway install')
    expect(msg).toContain('skelm gateway start --foreground')
  })

  it('still offers --foreground where no service manager exists', () => {
    const msg = formatStartGuidanceMessage({ canInstall: false })
    expect(msg).toContain('skelm gateway start --foreground')
    expect(msg).not.toContain('skelm gateway install')
  })
})
