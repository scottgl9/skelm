/**
 * Tiny argv parser sized for skelm's CLI. We deliberately avoid a heavy
 * argv library at this stage; we have one canonical command (`run`) plus
 * `--help` / `--version`. When the surface grows, swap this out.
 */

export interface ParsedArgv {
  command: 'run' | 'init' | 'version' | 'help' | 'unknown'
  positional: string[]
  flags: Record<string, string | boolean>
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  if (argv.length === 0) {
    return { command: 'help', positional: [], flags: {} }
  }
  const first = argv[0]
  if (first === undefined) {
    return { command: 'help', positional: [], flags: {} }
  }
  if (first === '--version' || first === '-V') {
    return { command: 'version', positional: [], flags: {} }
  }
  if (first === '--help' || first === '-h') {
    return { command: 'help', positional: [], flags: {} }
  }
  if (first === 'run') {
    return parseSubcommand('run', argv.slice(1))
  }
  if (first === 'init') {
    return parseSubcommand('init', argv.slice(1))
  }
  return { command: 'unknown', positional: [first], flags: {} }
}

function parseSubcommand(command: 'run' | 'init', rest: readonly string[]): ParsedArgv {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === undefined) continue
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        i++
      } else {
        flags[name] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags }
}
