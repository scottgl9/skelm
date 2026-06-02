import { statSync } from 'node:fs'
import { relative as pathRelative, resolve as pathResolve } from 'node:path'
import { EXIT } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO, MainResult } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'

export interface ScheduleAddArgs {
  subcommand: 'add'
  workflowId: string
  id?: string
  /** Cron expression e.g. "* /5 * * * *" (every 5 min) */
  cron?: string
  /**
   * IANA timezone for cron evaluation, e.g. `America/Chicago`. Only valid
   * paired with `--cron`. The gateway evaluates `cron` in this zone, honoring
   * DST. Without this flag the cron evaluates in the gateway host's TZ
   * (commonly UTC for systemd services).
   */
  tz?: string
  /** Interval in ms */
  everyMs?: number
  /**
   * Interval as a duration string: `30s`, `15m`, `2h`, `1d`, `500ms`. The
   * gateway resolves to `everyMs` server-side; unparseable values 400.
   */
  every?: string
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
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }
  const { discovery, headers } = client

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
  const res = await fetchHttp(`${baseUrl}/schedules`, { headers }, io)
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return httpError(res, io)
  const schedules = (await res.json()) as ScheduleEntry[]
  if (args.json) {
    writeJsonOutput(io, schedules)
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
    if (args.tz !== undefined) {
      trigger.tz = args.tz
    }
  } else if (args.everyMs !== undefined) {
    trigger = { kind: 'interval', everyMs: args.everyMs }
  } else if (args.every !== undefined) {
    trigger = { kind: 'interval', every: args.every }
  } else if (args.webhook !== undefined) {
    trigger = { kind: 'webhook', path: args.webhook }
  } else if (args.at !== undefined) {
    trigger = { kind: 'at', when: args.at }
  } else {
    io.stderr.write(
      'error: skelm schedule add requires a trigger flag.\n' +
        '  --cron "<expr>"       e.g. --cron "0 * * * *"\n' +
        '  --every <duration>    e.g. --every 30s | 5m | 2h\n' +
        '  --every-ms <number>   millisecond interval\n' +
        '  --webhook <path>      e.g. --webhook /hooks/build\n' +
        '  --at <ISO timestamp>  one-shot, e.g. --at 2026-01-01T00:00:00Z\n' +
        'See `skelm schedule --help` for full usage.\n',
    )
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (args.tz !== undefined && args.cron === undefined) {
    io.stderr.write('error: --tz requires --cron\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  // F044: the user types a path that is relative to their cwd
  // (e.g. `test_plan/fixtures/cron-with-input.workflow.ts`), but the gateway
  // stores workflow ids relative to its registry glob root
  // (e.g. `fixtures/cron-with-input.workflow.ts`). Without normalisation the
  // trigger registers fine, the cron timer fires, and the dispatcher then
  // errors `workflow not registered: <user-path>` — silently parked on the
  // registration as `lastError` while `GET /runs?triggerId=<id>` stays empty.
  const resolvedWorkflowId = await resolveWorkflowId(args.workflowId, baseUrl, headers, io)
  if (resolvedWorkflowId === null) return { exitCode: EXIT.CLI_ERROR }

  const body: Record<string, unknown> = {
    id: args.id ?? generateId(resolvedWorkflowId),
    workflowId: resolvedWorkflowId,
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

  const res = await fetchHttp(
    `${baseUrl}/schedules`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return httpError(res, io)
  const schedule = (await res.json()) as ScheduleEntry
  if (args.json) {
    writeJsonOutput(io, schedule)
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
  const res = await fetchHttp(
    `${baseUrl}/schedules/${encodeURIComponent(args.id)}`,
    {
      method: 'DELETE',
      headers,
    },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (res.status === 404) {
    io.stderr.write(`error: schedule not found: ${args.id}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (!res.ok) return httpError(res, io)
  if (args.json) {
    writeJsonOutput(io, { ok: true, id: args.id })
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
  const res = await fetchHttp(
    `${baseUrl}/triggers/${encodeURIComponent(args.id)}/fire`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (res.status === 404) {
    io.stderr.write(`error: schedule not found: ${args.id}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (!res.ok) return httpError(res, io)
  if (args.json) {
    writeJsonOutput(io, { ok: true, id: args.id })
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

/**
 * Resolve a user-supplied workflow path to the gateway's canonical registry id.
 *
 * The user typically types a path relative to their shell cwd
 * (`test_plan/fixtures/foo.workflow.ts`), but the gateway stores workflows
 * by their registry-relative id (`fixtures/foo.workflow.ts`). Submitting
 * the cwd-relative form would register the trigger but quietly fail every
 * fire with `workflow not registered: <path>` (finding F044).
 *
 * Resolution order:
 *  1. exact match against a registered id → return as-is
 *  2. exact match against an absolute file path under the registry → return
 *     the registry id of that entry
 *  3. unique suffix match (registered id ends with the user input, ignoring
 *     a leading `./`) → return the registered id
 *
 * Ambiguous matches (more than one candidate) are an error — the user must
 * type a more specific path or use the exact registry id.
 *
 * If the gateway has not yet indexed the workflow at all, fall back to the
 * user input untouched and let the gateway report a clean error. We do NOT
 * silently accept an unknown id — the previous behaviour did exactly that
 * and is what F044 was.
 */
async function resolveWorkflowId(
  userInput: string,
  baseUrl: string,
  headers: Record<string, string>,
  io: MainIO,
): Promise<string | null> {
  const res = await fetchHttp(`${baseUrl}/pipelines`, { headers }, io)
  if (res === null) {
    // fetchHttp already wrote a stderr line on the underlying network error,
    // but it identified the request as "gateway HTTP request failed" without
    // saying which call — be explicit so the operator sees what was being
    // resolved.
    io.stderr.write(`error: failed to reach gateway at ${baseUrl}/pipelines\n`)
    return null
  }
  if (!res.ok) {
    // /pipelines is a documented endpoint; a non-200 here is a real gateway
    // problem, not "user typed a bad path". Surface and abort.
    io.stderr.write(`error: gateway /pipelines returned ${res.status}: ${await res.text()}\n`)
    return null
  }
  const pipelines = (await res.json()) as Array<{ id: string; file?: string }>
  // Empty registry: the gateway has not indexed any workflows yet (common
  // in tests that boot a bare gateway, or when the workflow is registered
  // later via /v1/workflows). Trust the user input — the alternative is
  // breaking valid setups for a hypothetical wrong path. Emit a warn so the
  // operator knows we couldn't actually validate the path.
  if (pipelines.length === 0) {
    io.stderr.write(
      `warn: gateway has no registered workflows yet — submitting "${userInput}" as-is (run \`skelm list\` once workflows are indexed to confirm the canonical id)\n`,
    )
    return userInput
  }
  // 1. exact match against registry id
  const exact = pipelines.find((p) => p.id === userInput)
  if (exact !== undefined) return exact.id
  // 2. exact match against the absolute file path
  const absUser = pathResolve(process.cwd(), userInput)
  const byFile = pipelines.find((p) => p.file === absUser)
  if (byFile !== undefined) return byFile.id
  // 3. unique suffix match
  const stripped = userInput.replace(/^\.\//, '')
  const suffixMatches = pipelines.filter((p) => p.id === stripped || p.id.endsWith(`/${stripped}`))
  if (suffixMatches.length === 1 && suffixMatches[0] !== undefined) return suffixMatches[0].id
  if (suffixMatches.length > 1) {
    io.stderr.write(
      `error: workflow id "${userInput}" is ambiguous — matches ${suffixMatches.length} registered workflows:\n${suffixMatches.map((p) => `  - ${p.id}`).join('\n')}\n`,
    )
    io.stderr.write('hint: use the full registry id from `skelm list`\n')
    return null
  }
  // 4. The input names a real workflow file on disk that the gateway has not
  // indexed (it lives outside the registry glob). `skelm run <path>` already
  // accepts such an arbitrary file by POSTing its absolute path; a schedule
  // must end up with a registry id the trigger dispatcher can resolve at
  // fire time, so register it explicitly (POST /v1/workflows/register) and
  // schedule against the returned id. Without this, `schedule add
  // fixtures/foo.workflow.ts` errored "workflow not registered" even though
  // the file exists and `run` would have executed it.
  const fileId = await registerWorkflowFile(userInput, baseUrl, headers, io)
  if (fileId !== undefined) return fileId
  io.stderr.write(`error: workflow not registered: ${userInput}\n`)
  io.stderr.write('hint: run `skelm list` to see registered workflows\n')
  return null
}

/**
 * If `userInput` points at an existing workflow file on disk, register it
 * with the gateway and return the resulting registry id. Returns `undefined`
 * when the input is not a file (so the caller falls through to its
 * "not registered" error) or `null` when registration failed and an error
 * was already written.
 */
async function registerWorkflowFile(
  userInput: string,
  baseUrl: string,
  headers: Record<string, string>,
  io: MainIO,
): Promise<string | null | undefined> {
  const abs = pathResolve(process.cwd(), userInput)
  try {
    if (!statSync(abs).isFile()) return undefined
  } catch {
    return undefined
  }
  // Prefer a cwd-relative id (matches the registry's project-root-relative
  // ids); fall back to the absolute path when the file sits outside the cwd
  // tree. `..` segments are rejected by the gateway's id validator, so an
  // out-of-tree relative path is normalised to its absolute form.
  const rel = pathRelative(process.cwd(), abs)
  const id = rel !== '' && !rel.startsWith('..') ? rel : abs
  const res = await fetchHttp(
    `${baseUrl}/v1/workflows/register`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id, source: { type: 'path', path: abs } }),
    },
    io,
  )
  if (res === null) {
    io.stderr.write(`error: failed to reach gateway at ${baseUrl}/v1/workflows/register\n`)
    return null
  }
  if (!res.ok) {
    io.stderr.write(
      `error: failed to register workflow "${userInput}": ${res.status} ${await res.text()}\n`,
    )
    return null
  }
  const out = (await res.json()) as { workflow?: { id?: string } }
  return out.workflow?.id ?? id
}
