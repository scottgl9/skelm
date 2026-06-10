// Read-only gateway config inspection: `skelm gateway config list|get <path>`
// and `skelm gateway backend list`. Loads the operator's gateway config (no
// running gateway required — this is a `gateway *` exempt command) and prints
// it with every secret value redacted. Mutation is deliberately out of scope.

import { EXIT, type ExitCode } from './exit-codes.js'
import { loadGatewayConfig } from './load-config.js'

interface InspectIo {
  stdout: { write(s: string): void }
  stderr: { write(s: string): void }
}

// Keys whose string values are credentials and must never be printed.
const SECRET_KEY_RE = /^(api[-_]?key|token|access[-_]?token|password|secret|authorization|bearer)$/i

/**
 * Recursively redact a config value for display: a `{ secret: 'NAME' }`
 * reference becomes `<secret:NAME>`, a string under a credential-looking key
 * becomes `<redacted>`, and a constructed backend instance (function / class
 * object) collapses to `<instance>`. No secret value is ever emitted.
 */
export function redactConfig(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(redactConfig)
  if (typeof value === 'function') return '<instance>'
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.secret === 'string' && Object.keys(obj).length === 1) {
      return `<secret:${obj.secret}>`
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = typeof v === 'string' && SECRET_KEY_RE.test(k) ? '<redacted>' : redactConfig(v)
    }
    return out
  }
  return value
}

/** Resolve a dotted path within an object; `found:false` when any segment is missing. */
export function getConfigPath(obj: unknown, path: string): { found: boolean; value: unknown } {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as object))) {
      return { found: false, value: undefined }
    }
    cur = (cur as Record<string, unknown>)[part]
  }
  return { found: true, value: cur }
}

export interface GatewayInspectArgs {
  subcommand: 'config' | 'backend'
  action?: string | undefined
  path?: string | undefined
  json?: boolean
  gatewayConfig?: string | undefined
}

export async function gatewayInspectCommand(
  args: GatewayInspectArgs,
  io: InspectIo,
): Promise<{ exitCode: ExitCode }> {
  let resolved: Awaited<ReturnType<typeof loadGatewayConfig>>
  try {
    resolved = await loadGatewayConfig(
      args.gatewayConfig !== undefined ? { fromPath: args.gatewayConfig } : undefined,
    )
  } catch (err) {
    io.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  const config = resolved.config as unknown as Record<string, unknown>

  if (args.subcommand === 'config') {
    const action = args.action ?? 'list'
    if (action === 'list') {
      io.stderr.write(`# source: ${resolved.source ?? '(framework defaults)'}\n`)
      io.stdout.write(`${JSON.stringify(redactConfig(config), null, 2)}\n`)
      return { exitCode: EXIT.OK }
    }
    if (action === 'get') {
      if (args.path === undefined || args.path === '') {
        io.stderr.write('error: gateway config get requires a dotted path (e.g. server.port)\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      const { found, value } = getConfigPath(config, args.path)
      if (!found) {
        io.stderr.write(`error: no config value at "${args.path}"\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
      const out = redactConfig(value)
      io.stdout.write(`${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}\n`)
      return { exitCode: EXIT.OK }
    }
    io.stderr.write('error: gateway config requires "list" or "get <path>"\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  // subcommand === 'backend'
  const action = args.action ?? 'list'
  if (action === 'list') {
    const ids = new Set<string>()
    const backends = config.backends
    if (backends !== null && typeof backends === 'object') {
      for (const k of Object.keys(backends as Record<string, unknown>)) ids.add(k)
    }
    const instances = config.instances
    if (Array.isArray(instances)) {
      for (const inst of instances) {
        const id = (inst as { id?: unknown } | null)?.id
        if (typeof id === 'string') ids.add(id)
      }
    }
    const list = [...ids].sort()
    if (args.json === true) {
      io.stdout.write(`${JSON.stringify(list, null, 2)}\n`)
    } else {
      io.stdout.write(
        list.length === 0
          ? '(no backends configured)\n'
          : `${list.map((id) => `- ${id}`).join('\n')}\n`,
      )
    }
    return { exitCode: EXIT.OK }
  }
  io.stderr.write('error: gateway backend requires "list"\n')
  return { exitCode: EXIT.CLI_ERROR }
}
