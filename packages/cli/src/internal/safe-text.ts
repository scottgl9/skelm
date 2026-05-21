import { stripVTControlCharacters } from 'node:util'

/**
 * Strip ANSI/VT control sequences before writing untrusted text to a
 * TTY. Without stripping, an attacker-controlled tool/model output
 * (step ids, error messages, log lines) can move the cursor, clear the
 * screen, or `\r`-overwrite earlier output to hide the real commands a
 * user just ran. The strip is cheap and idempotent.
 */
export function safeForTty(text: string): string {
  return stripVTControlCharacters(text)
}
