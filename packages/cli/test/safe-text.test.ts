import { describe, expect, it } from 'vitest'
import { safeForTty } from '../src/internal/safe-text.js'

// Regression: untrusted text (tool/model error messages, step ids, log
// lines) used to be written straight to stderr/stdout. ANSI/VT control
// sequences in that text could move the cursor, clear the screen, or
// `\r`-overwrite earlier output — a tool prompt could forge CLI output
// to hide the real commands the user ran.

describe('safeForTty', () => {
  it('strips CSI cursor-up sequences', () => {
    const malicious = '\x1b[1AOverwritten line'
    expect(safeForTty(malicious)).toBe('Overwritten line')
  })

  it('strips clear-screen and color sequences', () => {
    const malicious = '\x1b[2J\x1b[31mRED\x1b[0m'
    expect(safeForTty(malicious)).toBe('RED')
  })

  it('preserves regular text including newlines and tabs', () => {
    expect(safeForTty('hello\n  world\t!')).toBe('hello\n  world\t!')
  })

  it('is idempotent', () => {
    const once = safeForTty('\x1b[1Aboom')
    expect(safeForTty(once)).toBe(once)
  })
})
