/**
 * Built-in tools exposed to the agent loop. Each tool re-checks the
 * relevant permission via the supplied TrustEnforcer before doing work;
 * permission denial returns an isError tool result so the model can adapt
 * rather than crashing the run.
 */

// @subprocess-ok: native exec tool gated by AgentPermissions.allowedExecutables
import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'

import { PermissionDeniedError } from '@skelm/core'
import type { PermissionDimension } from '@skelm/core/permissions'
import type { TrustEnforcer } from '@skelm/core/permissions'
import type { Skill } from '@skelm/core/skills'

import type { OpenAITool } from './http-client.js'

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface ToolExecutionContext {
  cwd: string
  agentDefRoot: string
  enforcer: TrustEnforcer
  loadSkill?: ((skillId: string) => Promise<Skill | null>) | undefined
  fetch?: typeof globalThis.fetch | undefined
  secrets?: Readonly<Record<string, string>> | undefined
  signal?: AbortSignal | undefined
  events?:
    | {
        publish: (ev: unknown) => void
        runId?: string
        stepId?: string
      }
    | undefined
}

export type ToolHandler = (args: unknown, ctx: ToolExecutionContext) => Promise<ToolResult>

export interface BuiltInToolDef {
  name: string
  description: string
  parameters?: Record<string, unknown>
  handler: ToolHandler
}

function normalizePath(input: string, ctx: ToolExecutionContext): string {
  const resolved = isAbsolute(input) ? resolve(input) : resolve(ctx.cwd, input)
  const acceptedRoots: string[] = [ctx.cwd, ctx.agentDefRoot]
  // Also accept any root the caller explicitly granted via permissions.
  // Without this, a user grant of `fsRead: ['/tmp/x']` is dead unless /tmp/x
  // happens to live under cwd or agentDefRoot — the enforcer.canRead check
  // below this layer never gets a chance to apply. The enforcer still gates
  // every read/write at the tool handler, so adding allowlisted roots here
  // does not widen access; it only stops the prefix guard from short-
  // circuiting a path the operator already authorized.
  for (const r of ctx.enforcer.policy.fsRead) acceptedRoots.push(r)
  for (const r of ctx.enforcer.policy.fsWrite) acceptedRoots.push(r)
  for (const raw of acceptedRoots) {
    const root = raw.endsWith('/') ? raw.slice(0, -1) : raw
    if (resolved === root || resolved.startsWith(`${root}/`)) return resolved
  }
  throw new PermissionDeniedError(
    `Path escape: ${resolved} is outside workspace (${ctx.cwd}), agentDefRoot (${ctx.agentDefRoot}), and any granted fsRead/fsWrite root`,
  )
}

function requireParentDir(filepath: string): string {
  const lastSlash = filepath.lastIndexOf('/')
  return lastSlash > 0 ? filepath.slice(0, lastSlash) : '.'
}

function publishDenied(
  events: ToolExecutionContext['events'],
  dimension: PermissionDimension,
  detail: string,
): void {
  if (!events) return
  events.publish({
    type: 'permission.denied' as const,
    ...(events.runId ? { runId: events.runId } : {}),
    ...(events.stepId ? { stepId: events.stepId } : {}),
    dimension,
    detail,
    at: Date.now(),
  })
}

export const BUILTIN_TOOLS: BuiltInToolDef[] = [
  {
    name: 'fs_read',
    description:
      'Read the contents of a text file. Use for reading config files, source code, logs, documentation, or any text-based file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to read.' },
      },
      required: ['path'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path: string }
      if (!p.path) return { content: 'Error: path is required', isError: true }
      try {
        const resolved = normalizePath(p.path, ctx)
        const decision = ctx.enforcer.canRead(resolved)
        if (!decision.allow) {
          publishDenied(ctx.events, 'fs.read', `fs_read denied: ${resolved} — ${decision.reason}`)
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const content = await readFile(resolved, 'utf-8')
        return { content }
      } catch (err) {
        return { content: `Error reading file: ${(err as Error).message}`, isError: true }
      }
    },
  },

  {
    name: 'fs_read_glob',
    description:
      'List files in a directory. Supports a simple pattern filter (no recursive glob in stdlib).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list.' },
        pattern: {
          type: 'string',
          description: 'Optional glob pattern filter (e.g. "*.ts").',
        },
      },
      required: ['path'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path: string; pattern?: string }
      try {
        const resolved = normalizePath(p.path, ctx)
        const decision = ctx.enforcer.canRead(resolved)
        if (!decision.allow) {
          publishDenied(
            ctx.events,
            'fs.read',
            `fs_read_glob denied: ${resolved} — ${decision.reason}`,
          )
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const entries = await readdir(resolved, { withFileTypes: true })
        let names = entries.map((e) => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`)
        if (p.pattern) {
          const regex = new RegExp(`^${p.pattern.replace(/\*/g, '.*')}$`)
          names = names.filter((n) => regex.test(n.split(' ')[1] ?? n))
        }
        return { content: names.join('\n') || '(empty)' }
      } catch (err) {
        return { content: `Error listing directory: ${(err as Error).message}`, isError: true }
      }
    },
  },

  {
    name: 'fs_write',
    description: 'Write or overwrite a file. Creates parent directories if they do not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to write.' },
        content: { type: 'string', description: 'File contents to write.' },
      },
      required: ['path', 'content'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path: string; content: string }
      if (!p.path) return { content: 'Error: path is required', isError: true }
      try {
        const resolved = normalizePath(p.path, ctx)
        const decision = ctx.enforcer.canWrite(resolved)
        if (!decision.allow) {
          publishDenied(ctx.events, 'fs.write', `fs_write denied: ${resolved} — ${decision.reason}`)
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const parent = requireParentDir(resolved)
        await mkdir(parent, { recursive: true })
        await writeFile(resolved, p.content, 'utf-8')
        return { content: `Written ${resolved} (${p.content.length} bytes)` }
      } catch (err) {
        return { content: `Error writing file: ${(err as Error).message}`, isError: true }
      }
    },
  },

  {
    name: 'fs_append',
    description:
      'Append text to the end of an existing file. Creates the file if it does not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        content: { type: 'string', description: 'Text to append.' },
      },
      required: ['path', 'content'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path: string; content: string }
      if (!p.path) return { content: 'Error: path is required', isError: true }
      try {
        const resolved = normalizePath(p.path, ctx)
        const decision = ctx.enforcer.canWrite(resolved)
        if (!decision.allow) {
          publishDenied(
            ctx.events,
            'fs.write',
            `fs_append denied: ${resolved} — ${decision.reason}`,
          )
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const parent = requireParentDir(resolved)
        await mkdir(parent, { recursive: true })
        await appendFile(resolved, p.content, 'utf-8')
        return { content: `Appended to ${resolved} (${p.content.length} bytes)` }
      } catch (err) {
        return { content: `Error appending to file: ${(err as Error).message}`, isError: true }
      }
    },
  },

  {
    name: 'http_fetch',
    description: 'Make an HTTP/HTTPS request. Supports GET, POST, PUT, DELETE, PATCH.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to request.' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          description: 'HTTP method (default: GET).',
        },
        headers: { type: 'object', description: 'Optional HTTP headers.' },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH).' },
      },
      required: ['url'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string
      }
      if (!p.url) return { content: 'Error: url is required', isError: true }

      let hostname: string
      try {
        const urlObj = new URL(p.url)
        hostname = urlObj.hostname
      } catch {
        return { content: `Error: invalid URL "${p.url}"`, isError: true }
      }

      const decision = ctx.enforcer.canFetch(hostname)
      if (!decision.allow) {
        publishDenied(ctx.events, 'network', `http_fetch denied: ${hostname} — ${decision.reason}`)
        // Make the denial actionable. The intersection-only model means a
        // step-level `networkEgress: 'allow'` can be silently narrowed to
        // 'deny' by project defaults, which is the most common source of
        // surprise here. Point users at where to look.
        const hint =
          decision.reason === 'no-policy'
            ? ` (no network policy in effect — grant 'networkEgress: \\'allow\\'' or specific allowHosts in skelm.config.ts \`defaults.permissions\`, since step-level grants intersect with project defaults and cannot widen them).`
            : decision.reason === 'host-not-allowed'
              ? ` (host '${hostname}' not in allowHosts — extend the project-default \`networkEgress.allowHosts\` in skelm.config.ts).`
              : ''
        return { content: `Permission denied: ${decision.reason}${hint}`, isError: true }
      }

      const fetchFn = ctx.fetch ?? globalThis.fetch
      const init: RequestInit = {
        method: p.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(p.headers ?? {}),
        },
      }
      if (p.body !== undefined) {
        init.body = p.body
      }

      try {
        const res = await fetchFn(p.url, init)
        const text = await res.text()
        const result: Record<string, unknown> = {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          body: text.length > 4096 ? `${text.slice(0, 4096)}\n… (truncated)` : text,
        }
        return { content: JSON.stringify(result, null, 2) }
      } catch (err) {
        return { content: `Error fetching ${p.url}: ${(err as Error).message}`, isError: true }
      }
    },
  },

  {
    name: 'ls',
    description: 'List files and directories. Supports recursive listing with --recursive flag.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list (default: current working directory).',
        },
        recursive: { type: 'boolean', description: 'List recursively.' },
      },
      required: [],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path?: string; recursive?: boolean }
      try {
        const target = p.path ? normalizePath(p.path, ctx) : ctx.cwd
        const decision = ctx.enforcer.canRead(target)
        if (!decision.allow) {
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const entries = await readdir(target, { withFileTypes: true })
        const lines = entries.map((e) => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`).join('\n')
        return { content: lines || '(empty)' }
      } catch (err) {
        return { content: `Error listing: ${(err as Error).message}`, isError: true }
      }
    },
  },

  {
    name: 'get_secret',
    description:
      'Retrieve a secret value by name. Secrets are injected by the skelm runner and are never logged.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The secret name to look up.' },
      },
      required: ['name'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { name: string }
      if (!p.name) return { content: 'Error: name is required', isError: true }
      const secrets = ctx.secrets
      if (!secrets) return { content: 'Error: no secrets available for this step', isError: true }
      if (!(p.name in secrets)) {
        return { content: `Error: secret "${p.name}" not found`, isError: true }
      }
      return { content: `Secret "${p.name}" is available (value masked for security)` }
    },
  },

  {
    name: 'load_skill',
    description:
      'Load a skelm skill by ID. Returns skill metadata if allowed by the permission policy.',
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'The skill identifier to load.' },
      },
      required: ['skillId'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { skillId: string }
      if (!p.skillId) return { content: 'Error: skillId is required', isError: true }
      const skill = ctx.loadSkill ? await ctx.loadSkill(p.skillId) : null
      if (!skill) {
        // The loader returns null for two distinct reasons that look
        // identical from the tool's POV:
        //   1. The skill id is absent from the registry / filesystem.
        //   2. The allowedSkills policy rejected it. Step-level
        //      `allowedSkills: ['foo']` is intersected with the project
        //      default; if the default is `[]` (the framework's default
        //      posture), the intersection is empty and every skill load
        //      fails. Surface that as a hint so users know where to
        //      widen the policy.
        return {
          content: `Skill "${p.skillId}" not found or not accessible (either the skill is missing from the project's skills registry, or the resolved \`allowedSkills\` policy is empty — step-level grants intersect with project defaults and cannot widen them, so set \`defaults.permissions.allowedSkills: ['${p.skillId}']\` in skelm.config.ts).`,
          isError: true,
        }
      }
      const info: Record<string, unknown> = {
        id: skill.id,
        name: skill.id,
        description: skill.description,
      }
      if (skill.metadata['allowed-tools']) {
        info.allowedTools = skill.metadata['allowed-tools']
      }
      if (skill.metadata.compatibility) {
        info.compatibility = skill.metadata.compatibility
      }
      return { content: JSON.stringify(info, null, 2) }
    },
  },

  // Run an executable from AgentPermissions.allowedExecutables. No shell is
  // invoked: argv is passed directly to spawn() with shell:false, so shell
  // metacharacters in args are NOT expanded. To run a shell pipeline, the
  // caller must put `bash` (or similar) in allowedExecutables AND pass
  // `["-c", "<pipeline>"]` as args — granting that is a deliberate choice.
  {
    name: 'exec',
    description:
      'Execute an allowed binary (no shell). Returns exitCode + stdout + stderr. ' +
      "The binary basename must be present in the step's allowedExecutables " +
      'policy. Argv is passed directly; shell metacharacters are NOT expanded.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Binary to execute (basename, e.g. "curl", or absolute path). ' +
            'basename(command) is checked against allowedExecutables.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Positional argv (no shell expansion).',
        },
        cwd: {
          type: 'string',
          description:
            'Working directory for the process. Must be readable per fsRead policy. ' +
            'Defaults to the agent step cwd.',
        },
        stdin: { type: 'string', description: 'Optional stdin payload.' },
        timeoutMs: {
          type: 'number',
          description: 'Hard timeout in milliseconds (default 30000, max 300000).',
        },
      },
      required: ['command'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as {
        command: string
        args?: readonly string[]
        cwd?: string
        stdin?: string
        timeoutMs?: number
      }
      if (!p.command) {
        return { content: 'Error: command is required', isError: true }
      }
      const binary = basename(p.command)
      const decision = ctx.enforcer.canExec(p.command)
      if (!decision.allow) {
        publishDenied(ctx.events, 'executable', `exec denied: ${p.command} — ${decision.reason}`)
        return { content: `Permission denied: ${decision.reason}`, isError: true }
      }

      let cwd: string = ctx.cwd
      if (p.cwd !== undefined) {
        try {
          cwd = normalizePath(p.cwd, ctx)
        } catch (err) {
          return { content: `Error: ${(err as Error).message}`, isError: true }
        }
        const cwdDecision = ctx.enforcer.canRead(cwd)
        if (!cwdDecision.allow) {
          publishDenied(ctx.events, 'fs.read', `exec cwd denied: ${cwd} — ${cwdDecision.reason}`)
          return { content: `Permission denied: ${cwdDecision.reason}`, isError: true }
        }
      }

      const argv = (p.args ?? []).map((a) => String(a))
      const timeoutMs = Math.min(Math.max(p.timeoutMs ?? 30_000, 1), 300_000)
      const STDOUT_CAP = 64 * 1024
      const STDERR_CAP = 64 * 1024

      return await new Promise<ToolResult>((resolvePromise) => {
        let stdout = ''
        let stderr = ''
        let stdoutTruncated = false
        let stderrTruncated = false
        let settled = false

        const child = spawn(p.command, argv, {
          cwd,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        })

        const timer = setTimeout(() => {
          if (settled) return
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }, timeoutMs)

        const onAbort = (): void => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }
        ctx.signal?.addEventListener('abort', onAbort, { once: true })

        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdout.length >= STDOUT_CAP) {
            stdoutTruncated = true
            return
          }
          const room = STDOUT_CAP - stdout.length
          const piece = chunk.toString('utf-8')
          if (piece.length <= room) {
            stdout += piece
          } else {
            stdout += piece.slice(0, room)
            stdoutTruncated = true
          }
        })

        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length >= STDERR_CAP) {
            stderrTruncated = true
            return
          }
          const room = STDERR_CAP - stderr.length
          const piece = chunk.toString('utf-8')
          if (piece.length <= room) {
            stderr += piece
          } else {
            stderr += piece.slice(0, room)
            stderrTruncated = true
          }
        })

        child.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          ctx.signal?.removeEventListener('abort', onAbort)
          resolvePromise({
            content: `Error executing ${binary}: ${err.message}`,
            isError: true,
          })
        })

        child.on('close', (code, signal) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          ctx.signal?.removeEventListener('abort', onAbort)
          const result: Record<string, unknown> = {
            exitCode: code,
            ...(signal !== null && { signal }),
            stdout,
            stderr,
            ...(stdoutTruncated && { stdoutTruncated: true }),
            ...(stderrTruncated && { stderrTruncated: true }),
          }
          resolvePromise({ content: JSON.stringify(result, null, 2) })
        })

        if (p.stdin !== undefined && child.stdin !== null) {
          child.stdin.end(p.stdin)
        } else if (child.stdin !== null) {
          child.stdin.end()
        }
      })
    },
  },
]

export function toOpenAITool(tool: BuiltInToolDef): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      ...(tool.parameters && { parameters: tool.parameters }),
    },
  }
}
