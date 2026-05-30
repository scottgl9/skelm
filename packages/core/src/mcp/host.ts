import { basename } from 'node:path'
import { PermissionDeniedError, RunCancelledError } from '../errors.js'
import type { EventBus } from '../events.js'
import type { PermissionDimension, TrustEnforcer } from '../permissions.js'
import type { RunId, StepId } from '../types-base.js'
import { McpClient } from './client.js'
import type { ToolCallResponse } from './protocol.js'
import type { McpServerConfig } from './types.js'

export interface McpHostedTool {
  id: string
  serverId: string
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: Record<string, unknown>
}

export interface McpHost {
  listTools(): Promise<readonly McpHostedTool[]>
  invokeTool(toolId: string, args: unknown, signal?: AbortSignal): Promise<ToolCallResponse>
  dispose(): Promise<void>
}

export interface McpHostOptions {
  enforcer?: TrustEnforcer
  // McpHost only calls `publish` on this — widened to a publish-only
  // shape so backends that don't hold a full EventBus can still forward
  // their `BackendContext.events` channel without an upcast.
  events?: Pick<EventBus, 'publish'>
  runId?: RunId
  stepId?: StepId
}

export async function createMcpHost(
  servers: readonly McpServerConfig[],
  opts: McpHostOptions = {},
): Promise<McpHost> {
  const clients = new Map<string, McpClient>()

  try {
    for (const server of servers) {
      const client = new McpClient()
      switch (server.transport) {
        case 'stdio':
          await client.start({
            command: server.command,
            ...(server.args !== undefined && { args: server.args }),
            ...(server.env !== undefined && { env: server.env }),
          })
          break
        case 'http':
          await client.connectHttp({
            url: server.url,
            ...(server.headers !== undefined && { headers: server.headers }),
          })
          break
        case 'sse':
          throw new Error(
            `MCP host supports stdio and http servers only in this stage (${server.id})`,
          )
      }
      clients.set(server.id, client)
    }
  } catch (err) {
    for (const client of clients.values()) {
      await client.stop()
    }
    throw err
  }

  return {
    async listTools(): Promise<readonly McpHostedTool[]> {
      const tools: McpHostedTool[] = []
      for (const [serverId, client] of clients) {
        const listed = await client.listTools()
        for (const tool of listed.tools) {
          tools.push({
            id: `${serverId}.${tool.name}`,
            serverId,
            name: tool.name,
            ...(tool.description !== undefined && { description: tool.description }),
            ...(tool.inputSchema !== undefined && { inputSchema: tool.inputSchema }),
            ...(tool.annotations !== undefined && { annotations: tool.annotations }),
          })
        }
      }
      return tools
    },
    async invokeTool(
      toolId: string,
      args: unknown,
      signal?: AbortSignal,
    ): Promise<ToolCallResponse> {
      const { serverId, toolName } = splitToolId(toolId)
      const client = clients.get(serverId)
      if (!client) {
        throw new Error(`unknown MCP server: ${serverId}`)
      }
      const enforcer = opts.enforcer
      if (enforcer) {
        const toolDecision = enforcer.canCallTool(toolId)
        if (!toolDecision.allow) {
          publishPermissionDenied(opts, toolId, toolDecision.dimension, toolDecision.reason)
          throw new PermissionDeniedError(
            `tool "${toolId}" is not allowed for this agent step (${toolDecision.reason})`,
          )
        }

        const executable = requestedExecutable(toolName, args)
        if (executable !== undefined) {
          const execDecision = enforcer.canExec(executable)
          if (!execDecision.allow) {
            publishPermissionDenied(
              opts,
              toolId,
              execDecision.dimension,
              execDecision.reason,
              `tool "${toolId}" requested executable "${executable}"`,
            )
            throw new PermissionDeniedError(
              `tool "${toolId}" requested executable "${executable}" which is not allowed (${execDecision.reason})`,
            )
          }
        }

        // A tool can touch more than one path (e.g. move_file/copy_file/rename
        // read/remove a source AND write a destination). EVERY path it touches
        // must satisfy the allowlist, or the unchecked one escapes it.
        for (const fsAccess of requestedFsPaths(toolName, args)) {
          const fsDecision = fsAccess.write
            ? enforcer.canWrite(fsAccess.path)
            : enforcer.canRead(fsAccess.path)
          if (!fsDecision.allow) {
            publishPermissionDenied(
              opts,
              toolId,
              fsDecision.dimension,
              fsDecision.reason,
              `tool "${toolId}" requested ${fsAccess.write ? 'write' : 'read'} access to "${fsAccess.path}"`,
            )
            throw new PermissionDeniedError(
              `tool "${toolId}" requested ${fsAccess.write ? 'write' : 'read'} access to "${fsAccess.path}" which is not allowed (${fsDecision.reason})`,
            )
          }
        }
      }

      const startedAt = Date.now()
      publishToolCall(opts, toolId, args, startedAt)
      const result = await awaitWithAbort(client.callTool(toolName, args), signal)
      publishToolResult(opts, toolId, result, startedAt)
      return result
    },
    async dispose(): Promise<void> {
      await Promise.all([...clients.values()].map((client) => client.stop()))
      clients.clear()
    },
  }
}

function splitToolId(toolId: string): { serverId: string; toolName: string } {
  const dot = toolId.indexOf('.')
  if (dot < 1 || dot === toolId.length - 1) {
    throw new Error(`invalid MCP tool id: ${toolId}`)
  }
  return {
    serverId: toolId.slice(0, dot),
    toolName: toolId.slice(dot + 1),
  }
}

function publishToolCall(opts: McpHostOptions, toolId: string, args: unknown, at: number): void {
  if (opts.events === undefined || opts.runId === undefined || opts.stepId === undefined) return
  opts.events.publish({
    type: 'tool.call',
    runId: opts.runId,
    stepId: opts.stepId,
    tool: toolId,
    arguments: args,
    at,
  })
}

function publishToolResult(
  opts: McpHostOptions,
  toolId: string,
  result: unknown,
  startedAt: number,
): void {
  if (opts.events === undefined || opts.runId === undefined || opts.stepId === undefined) return
  const completedAt = Date.now()
  opts.events.publish({
    type: 'tool.result',
    runId: opts.runId,
    stepId: opts.stepId,
    tool: toolId,
    result,
    durationMs: completedAt - startedAt,
    at: completedAt,
  })
}

function publishPermissionDenied(
  opts: McpHostOptions,
  toolId: string,
  dimension: PermissionDimension,
  reason: string,
  detail = `tool "${toolId}" was denied by ${dimension} policy (${reason})`,
): void {
  if (opts.events === undefined || opts.runId === undefined || opts.stepId === undefined) return
  const at = Date.now()
  opts.events.publish({
    type: 'tool.denied',
    runId: opts.runId,
    stepId: opts.stepId,
    tool: toolId,
    reason: reason as never,
    at,
  })
  opts.events.publish({
    type: 'permission.denied',
    runId: opts.runId,
    stepId: opts.stepId,
    dimension,
    detail,
    at,
  })
}

// Tool names whose invocation constitutes running an arbitrary shell command.
// Covers mcp-server-shell, mcp-server-commands, desktop-commander, and similar.
const SHELL_TOOL_NAMES = new Set([
  'bash',
  'sh',
  'shell',
  'exec',
  'execute',
  'execute_command',
  'run_command',
  'run_shell_command',
  'terminal',
  'terminal_exec',
  'spawn',
])

function requestedExecutable(toolName: string, args: unknown): string | undefined {
  if (!SHELL_TOOL_NAMES.has(toolName)) return undefined
  // bash and sh always resolve to themselves regardless of args content
  if (toolName === 'bash' || toolName === 'sh') return toolName
  return extractBinary(args)
}

function extractBinary(args: unknown): string | undefined {
  if (typeof args === 'string') {
    return parseCommandBinary(args)
  }
  if (args === null || typeof args !== 'object') {
    return undefined
  }

  const record = args as Record<string, unknown>
  const argv = record.argv
  if (Array.isArray(argv) && typeof argv[0] === 'string') {
    return basename(argv[0])
  }
  const command = record.command
  if (typeof command === 'string') {
    return parseCommandBinary(command)
  }
  const cmd = record.cmd
  if (typeof cmd === 'string') {
    return parseCommandBinary(cmd)
  }
  return undefined
}

function parseCommandBinary(command: string): string | undefined {
  const trimmed = command.trim()
  if (trimmed.length === 0) return undefined
  const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
  const token = match?.[1] ?? match?.[2] ?? match?.[3]
  return token === undefined ? undefined : basename(token)
}

// Write-indicating tool name suffixes used by common MCP filesystem servers
// (mcp-server-filesystem, @modelcontextprotocol/server-filesystem, etc.)
const FS_WRITE_NAMES = new Set([
  'write_file',
  'create_file',
  'edit_file',
  'delete_file',
  'move_file',
  'copy_file',
  'create_directory',
  'delete_directory',
  'rename',
  'overwrite',
  'append_to_file',
  'patch_file',
])

const FS_READ_NAMES = new Set([
  'read_file',
  // @modelcontextprotocol/server-filesystem renamed `read_file` →
  // `read_text_file` (and added `read_media_file`). Without these, a read via
  // the current server's tool names skips canRead() entirely and escapes the
  // fsRead allowlist — a filesystem-permission bypass.
  'read_text_file',
  'read_media_file',
  'get_file',
  'read_multiple_files',
  'list_directory',
  'list_files',
  'search_files',
  'stat_file',
  'get_file_info',
  'directory_tree',
])

// Two-path filesystem tools: they take a SOURCE and a DESTINATION. move_file is
// the @modelcontextprotocol/server-filesystem name; copy_file / rename are
// common variants. All three are in FS_WRITE_NAMES, so the source is checked as
// a write; the destination — which the operation creates/overwrites — must be
// checked as a write TOO. Extracting only the source (the historical behavior)
// left the destination unchecked: an agent restricted to fsWrite:['/sandbox']
// could move_file source=/sandbox/x destination=~/.ssh/authorized_keys and
// write outside the allowlist. Same class as the read_text_file bypass (#263).
const FS_TWO_PATH_NAMES = new Set(['move_file', 'copy_file', 'rename'])

function firstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    if (typeof record[k] === 'string') return record[k] as string
  }
  return undefined
}

/**
 * Extract every filesystem path a tool call touches, each tagged read/write.
 * Returns one entry for ordinary single-path fs tools, and a second entry (the
 * write destination) for two-path tools (move/copy/rename). Empty when the tool
 * is not a filesystem tool or no path can be extracted (best-effort: unknown
 * argument shapes contribute nothing).
 */
function requestedFsPaths(toolName: string, args: unknown): { path: string; write: boolean }[] {
  const isWrite = FS_WRITE_NAMES.has(toolName)
  const isRead = FS_READ_NAMES.has(toolName)
  if (!isWrite && !isRead) return []
  if (args === null || typeof args !== 'object') return []
  const record = args as Record<string, unknown>

  const reqs: { path: string; write: boolean }[] = []
  // Common path argument names from mcp-server-filesystem and similar servers.
  const primary = firstStringField(record, ['path', 'file_path', 'filename', 'source'])
  if (primary !== undefined) reqs.push({ path: primary, write: isWrite })

  if (FS_TWO_PATH_NAMES.has(toolName)) {
    const dest = firstStringField(record, [
      'destination',
      'dest',
      'to',
      'target',
      'new_path',
      'newPath',
    ])
    if (dest !== undefined) reqs.push({ path: dest, write: true })
  }
  return reqs
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) throw new RunCancelledError()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new RunCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
