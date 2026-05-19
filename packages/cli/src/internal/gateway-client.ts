import { homedir } from 'node:os'
import { join } from 'node:path'
import { type DiscoveryRecord, readDiscovery } from '@skelm/gateway'
import { EXIT } from '../exit-codes.js'
import type { MainIO, MainResult } from '../main.js'

export interface GatewayClient {
  discovery: DiscoveryRecord
  headers: Record<string, string>
  stateDir: string
}

export function gatewayStateDir(): string {
  return process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
}

export async function loadDiscovery(stateDir?: string): Promise<DiscoveryRecord | null> {
  const dir = stateDir ?? gatewayStateDir()
  return readDiscovery(join(dir, 'gateway.json'))
}

export async function ensureGatewayReady(io: MainIO): Promise<GatewayClient | null> {
  const stateDir = gatewayStateDir()
  const discovery = await loadDiscovery(stateDir)
  if (discovery === null) {
    io.stderr.write('error: gateway is not running — start it with `skelm gateway start`\n')
    return null
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (discovery.token !== undefined) headers.authorization = `Bearer ${discovery.token}`
  return { discovery, headers, stateDir }
}

export async function fetchHttp(
  url: string,
  init: RequestInit | undefined,
  io: MainIO,
): Promise<Response | null> {
  try {
    return await fetch(url, init)
  } catch (err) {
    io.stderr.write(`error: gateway HTTP request failed: ${(err as Error).message}\n`)
    return null
  }
}

export async function httpError(res: Response, io: MainIO): Promise<MainResult> {
  io.stderr.write(`error: gateway returned ${res.status}: ${await res.text()}\n`)
  return { exitCode: EXIT.CLI_ERROR }
}
