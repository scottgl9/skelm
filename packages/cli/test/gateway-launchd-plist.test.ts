import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLaunchdPlist } from '../src/gateway.js'

describe('launchd plist template', () => {
  it('embeds absolute paths to node and the skelm bin in ProgramArguments', () => {
    const plist = buildLaunchdPlist()
    // Extract the four argv strings inside <ProgramArguments><array>...</array>.
    const argv = [...plist.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1] ?? '')
    // First match is the Label; ProgramArguments starts at index 1.
    const [, nodePath, skelmBin, gw, start, foreground] = argv
    expect(nodePath).toBeDefined()
    expect(skelmBin).toBeDefined()
    expect(isAbsolute(nodePath as string)).toBe(true)
    expect(isAbsolute(skelmBin as string)).toBe(true)
    expect(gw).toBe('gateway')
    expect(start).toBe('start')
    expect(foreground).toBe('--foreground')
  })

  it('declares Label com.skelm.gateway', () => {
    const plist = buildLaunchdPlist()
    expect(plist).toContain('<key>Label</key>')
    expect(plist).toContain('<string>com.skelm.gateway</string>')
  })

  it('sets RunAtLoad true and KeepAlive on non-zero exit', () => {
    const plist = buildLaunchdPlist()
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    )
  })

  it('redirects stdout/stderr to the gateway log path', () => {
    const plist = buildLaunchdPlist()
    expect(plist).toContain('<key>StandardOutPath</key>')
    expect(plist).toContain('<key>StandardErrorPath</key>')
    expect(plist).toMatch(/gateway\.log/)
  })
})
