import { homedir } from 'node:os'
import { join } from 'node:path'
import { readDiscovery } from '@skelm/gateway'
import { EXIT } from './exit-codes.js'
import type { MainIO, MainResult } from './main.js'

export interface ScheduleAddArgs {
  subcommand: 'add'
  workflowId: string
  id?: string
  /** Cron expression e.g. "* /5 * * * *" (every 5 min) */
  cron?: string
  /** Interval in ms */
  everyMs?: number
  /** Webhook path e.g. /my-hook */
  webhook?: string
  /** At a specific ISO timestamp */
  at?: string
  /** Input JSON for the workflow run */
  input?: string
  overlap?: 'skip' | 'queue' | 'cancel'
  json?: boolean
}

export interface ScheduleListArgs {
  subcommand: 'list'
  json?: boolean
}

export interface ScheduleStopArgs {
  subcommand: 'stop'
  id: string
  json?: boolean
}

export interface ScheduleFireArgs {
  subcommand: 'fire'
  id: string
  json?: boolean
}

export type ScheduleArgs = ScheduleAddArgs | ScheduleListArgs | ScheduleStopArgs | ScheduleFireArgs

export async function scheduleCommand(args: ScheduleArgs, io: MainIO): Promise<MainResult> {
  const stateDir = process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
  const discovery = await readDiscovery(join(stateDir, 'gateway.json'))
  if (discovery === null) {
    io.stderr.write('error: gateway is not running — start it with `skelm gateway start`\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (discovery.token !== undefined) headers.authorization = `Bearer ${discovery.token}`

  switch (args.subcommand) {
    case 'list':
      return scheduleList(args, discovery.url, headers, io)
    case 'add':
      return scheduleAdd(args, discovery.url, headers, io)
    case 'stop':
      return scheduleStop(args, discovery.url, headers, io)
    case 'fire':
      return scheduleFire(args, discovery.url, headers, io)
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function scheduleList(
  args: ScheduleListArgs,
  baseUrl: string,
  headers: Record<string, string>,
  io: MainIO,
): Promise<MainResult> {
  const res = await fetchHttp(`${baseUrl}/schedules`, { headers })
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return httpError(res, io)
  const schedules = (await res.json()) as ScheduleEntry[]
  if (args.json) {
    io.stdout.write(`${JSON.stringify(schedules, null, 2)}\n`)
    return { exitCode: EXIT.OK }
  }
  if (schedules.length === 0) {
    io.stdout.write('no schedules registered\n')
    return { exitCode: EXIT.OK }
  }
  for (const s of schedules) {
    const triggerDesc = describeTrigger(s.trigger)
    const status = s.inflight ? ' (running)' : s.lastError ? ` (error: ${s.lastError})` : ''
    io.stdout.write(`${s.id}\t${s.workflowId}\t${triggerDesc}${status}\n`)
  }
  return { exitCode: EXIT.OK }
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function scheduleAdd(
  args: ScheduleAddArgs,
  baseUrl: string,
  headers: Record<string, string>,
  io: MainIO,
): Promise<MainResult> {
  // Build trigger spec from flags
  let trigger: Record<string, unknown>
  if (args.cron !== undefined) {
    trigger = { kind: 'cron', expression: args.cron }
  } else if (args.everyMs !== undefined) {
    trigger = { kind: 'interval', everyMs: args.everyMs }
  } else if (args.webhook !== undefined) {
    trigger = { kind: 'webhook', path: args.webhook }
  } else if (args.at !== undefined) {
    trigger = { kind: 'at', when: args.at }
  } else {
    io.stderr.write(
      'error: skelm schedule add requires one of --cron, --every-ms, --webhook, or --at\n',
    )
    return { exitCode: EXIT.CLI_ERROR }
  }

  const body: Record<string, unknown> = {
    id: args.id ?? generateId(args.workflowId),
    workflowId: args.workflowId,
    trigger,
    overlap: args.overlap ?? 'skip',
  }
  if (args.input !== undefined) {
    try {
      body.input = JSON.parse(args.input)
    } catch {
      io.stderr.write('error: --input must be valid JSON\n')
      return { exitCode: EXIT.CLI_ERROR }
    }
  }

  const res = await fetchHttp(`${baseUrl}/schedules`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return httpError(res, io)
  const schedule = (await res.json()) as ScheduleEntry
  if (args.json) {
    io.stdout.write(`${JSON.stringify(schedule, null, 2)}\n`)
  } else {
    const triggerDesc = describeTrigger(schedule.trigger)
    io.stdout.write(`registered ${schedule.id} — ${schedule.workflowId} — ${triggerDesc}\n`)
  }
  return { exitCode: EXIT.OK }
}

// ---------------------------------------------------------------------------
// stop (delete / unregister)
// ---------------------------------------------------------------------------

async function scheduleStop(
  args: ScheduleStopArgs,
  baseUrl: string,
  headers: Record<string, string>,
  io: MainIO,
): Promise<MainResult> {
  const res = await fetchHttp(`${baseUrl}/schedules/${encodeURIComponent(args.id)}`, {
    method: 'DELETE',
    headers,
  })
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (res.status === 404) {
    io.stderr.write(`error: schedule not found: ${args.id}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (!res.ok) return httpError(res, io)
  if (args.json) {
    io.stdout.write(`${JSON.stringify({ ok: true, id: args.id }, null, 2)}\n`)
  } else {
    io.stdout.write(`stopped ${args.id}\n`)
  }
  return { exitCode: EXIT.OK }
}

// ---------------------------------------------------------------------------
// fire (manual trigger)
// ---------------------------------------------------------------------------

async function scheduleFire(
  args: ScheduleFireArgs,
  baseUrl: string,
  headers: Record<string, string>,
  io: MainIO,
): Promise<MainResult> {
  const res = await fetchHttp(`${baseUrl}/triggers/${encodeURIComponent(args.id)}/fire`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (res.status === 404) {
    io.stderr.write(`error: schedule not found: ${args.id}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (!res.ok) return httpError(res, io)
  if (args.json) {
    io.stdout.write(`${JSON.stringify({ ok: true, id: args.id }, null, 2)}\n`)
  } else {
    io.stdout.write(`fired ${args.id}\n`)
  }
  return { exitCode: EXIT.OK }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScheduleEntry {
  id: string
  workflowId: string
  trigger: Record<string, unknown>
  overlap: string
  enabled: boolean
  fired: number
  inflight: boolean
  lastFiredAt?: string
  lastError?: string
}

function describeTrigger(trigger: Record<string, unknown>): string {
  switch (trigger.kind) {
    case 'cron':
      return `cron(${trigger.expression})`
    case 'interval':
      return `every ${trigger.everyMs}ms`
    case 'webhook':
      return `webhook(${trigger.path})`
    case 'at':
      return `at(${trigger.when})`
    case 'manual':
      return 'manual'
    case 'poll':
      return `poll(${trigger.sourceFnId}, every ${trigger.everyMs}ms)`
    case 'queue':
      return `queue(${trigger.driver})`
    default:
      return JSON.stringify(trigger)
  }
}

function generateId(workflowId: string): string {
  return `${workflowId}-${Date.now().toString(36)}`
}

async function fetchHttp(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, init)
  } catch (err) {
    process.stderr.write(`error: gateway HTTP request failed: ${(err as Error).message}\n`)
    return null
  }
}

async function httpError(res: Response, io: MainIO): Promise<MainResult> {
  io.stderr.write(`error: gateway returned ${res.status}: ${await res.text()}\n`)
  return { exitCode: EXIT.CLI_ERROR }
}
