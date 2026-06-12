// SkelmBackend wrapper around AcpClient.
//
// Spawns the configured ACP agent process, opens a session per call, sends
// the prompt, and aggregates the streaming response into an AgentResponse.
//
// Strict ACP mode is fail-closed: skelm does not assume an arbitrary ACP
// process can enforce skelm permission policies. Advisory mode is explicit
// opt-in and emits runtime/audit diagnostics before dispatch.

import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  McpServerConfig,
  SkelmBackend,
} from '../backend.js'
import type { ResolvedPolicy } from '../permissions.js'
import { AcpClient } from './client.js'
import type { ContentBlock, McpServerSpec } from './protocol.js'

export interface AcpBackendOptions {
  /** Backend id. Defaults to 'acp' when only one ACP backend is registered. */
  id?: string
  /** Human-readable label for diagnostics. */
  label?: string
  /** Command and args used to spawn the ACP agent. */
  command: string
  args?: readonly string[]
  /**
   * Model id to select after session start, sent as a `/model <id>` command.
   * Useful for ACP agents (e.g. opencode) that support model switching via
   * slash commands. When set, a `/model <id>` prompt is sent before the
   * actual task prompt; the turn is a no-op from the caller's perspective.
   */
  model?: string
  /** Optional working directory for the spawned agent. */
  cwd?: string
  /** Optional environment overlay for the agent process. */
  env?: NodeJS.ProcessEnv
  /**
   * Permission handling mode. `strict` preserves fail-closed behavior for
   * non-empty policies. `advisory` dispatches anyway and relies on gateway
   * diagnostics/audit to make the weaker guarantee visible.
   */
  permissionMode?: 'strict' | 'advisory'
  /**
   * Maximum number of concurrent agent processes. Defaults to 4. When the
   * limit is reached, additional calls queue until a slot is available.
   * Set to 0 for unlimited (not recommended for production).
   */
  maxConcurrent?: number
}

/**
 * Build a SkelmBackend that delegates agent() steps to an ACP-speaking
 * subprocess. One process per call by default; pooling lands in a future
 * stage.
 */
export function createAcpBackend(opts: AcpBackendOptions): SkelmBackend {
  const permissionMode = opts.permissionMode ?? 'strict'
  const capabilities: BackendCapabilities = {
    prompt: false,
    streaming: true,
    sessionLifecycle: true,
    mcp: true,
    skills: false,
    modelSelection: opts.model !== undefined,
    toolPermissions: permissionMode === 'advisory' ? 'advisory' : 'unsupported',
    // ACP defines image ContentBlock at the protocol layer; we pass image
    // parts through as extra prompt blocks. Sub-agents that cannot actually
    // process them will ignore or error themselves.
    vision: true,
  }

  // Concurrency semaphore — limits simultaneous agent processes
  const maxConcurrent = opts.maxConcurrent ?? 4
  let active = 0
  const queue: Array<() => void> = []

  const acquire = (): Promise<void> => {
    if (maxConcurrent === 0 || active < maxConcurrent) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => queue.push(resolve))
  }

  const release = () => {
    const next = queue.shift()
    if (next) {
      next()
    } else {
      active--
    }
  }

  const backend: SkelmBackend = {
    id: opts.id ?? 'acp',
    capabilities,
    async run(req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> {
      if (
        permissionMode !== 'advisory' &&
        ctx.permissions !== undefined &&
        isNontrivialPolicy(ctx.permissions)
      ) {
        throw new Error(
          'ACP backend cannot enforce permission policies; declare permissions on a backend with native or runtime enforcement instead',
        )
      }
      await acquire()
      const client = new AcpClient()
      const onAbort = () => client.cancel()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        await client.start({
          command: opts.command,
          ...(opts.args && { args: opts.args }),
          ...(opts.cwd !== undefined && { cwd: opts.cwd }),
          ...(opts.env !== undefined && { env: opts.env }),
        })
        await client.newSession({
          cwd: req.cwd ?? opts.cwd ?? process.cwd(),
          ...(req.mcpServers !== undefined && {
            mcpServers: req.mcpServers.map(toAcpMcpServerSpec),
          }),
        })
        // Select the model if specified. Sent as a slash command before the
        // actual prompt; the turn produces no content and is discarded.
        if (opts.model !== undefined) {
          await client.prompt({ text: `/model ${opts.model}` })
        }
        const result = await client.prompt(buildPrompt(req))
        return {
          text: result.text,
          stopReason: result.stopReason,
        }
      } finally {
        ctx.signal.removeEventListener('abort', onAbort)
        await client.stop()
        release()
      }
    },
  }
  if (opts.label !== undefined) {
    Object.assign(backend, { label: opts.label })
  }
  return backend
}

function isNontrivialPolicy(p: ResolvedPolicy): boolean {
  if (p.allowedTools.exact.size > 0 || p.allowedTools.prefixes.length > 0 || p.allowedTools.star) {
    return true
  }
  if (p.allowedExecutables.size > 0) return true
  // allowedMcpServers is forwarded to ACP via newSession; ACP enforces it natively.
  if (p.allowedSkills.size > 0) return true
  if (p.allowedSecrets.size > 0) return true
  if (p.fsRead.size > 0) return true
  if (p.fsWrite.size > 0) return true
  if (p.networkEgress !== 'deny') return true
  if (p.approval !== null) return true
  return false
}

function buildPrompt(req: AgentRequest): { text: string; extraBlocks?: ContentBlock[] } {
  // Collapse multimodal prompts into a leading text block plus image blocks
  // for the ACP protocol. Text-only callers stay on the fast path.
  if (typeof req.prompt === 'string') {
    const text = req.system === undefined ? req.prompt : `${req.system}\n\n---\n\n${req.prompt}`
    return { text }
  }
  const textParts: string[] = []
  const imageBlocks: ContentBlock[] = []
  for (const part of req.prompt) {
    if (part.type === 'text') {
      textParts.push(part.text)
    } else {
      imageBlocks.push({ type: 'image', mimeType: part.mimeType, data: part.data })
    }
  }
  const promptText = textParts.join('\n')
  const text = req.system === undefined ? promptText : `${req.system}\n\n---\n\n${promptText}`
  return imageBlocks.length > 0 ? { text, extraBlocks: imageBlocks } : { text }
}

function toAcpMcpServerSpec(server: McpServerConfig): McpServerSpec {
  switch (server.transport) {
    case 'stdio':
      return {
        type: 'stdio',
        name: server.id,
        command: server.command,
        ...(server.args !== undefined && { args: server.args }),
        ...(server.env !== undefined && {
          env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
        }),
      }
    case 'http':
      return {
        type: 'http',
        name: server.id,
        url: server.url,
        ...(server.headers !== undefined && {
          headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
        }),
      }
    case 'sse':
      return {
        type: 'sse',
        name: server.id,
        url: server.url,
        ...(server.headers !== undefined && {
          headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
        }),
      }
  }
}
