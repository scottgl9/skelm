// SkelmBackend wrapper around AcpClient.
//
// Spawns the configured ACP agent process, opens a session per call, sends
// the prompt, and aggregates the streaming response into an AgentResponse.
//
// `toolPermissions: 'native'`: ACP agents (opencode, copilot, claude) enforce
// permissions themselves at the process level. Skelm passes the resolved policy
// as advisory metadata in AgentRequest.permissions; the agent is responsible for
// honouring it. This is the correct model for externally-sandboxed agents that
// manage their own tool access.

import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  McpServerConfig,
  SkelmBackend,
} from '../backend.js'
import { AcpClient } from './client.js'
import type { McpServerSpec } from './protocol.js'

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
  const capabilities: BackendCapabilities = {
    prompt: false,
    streaming: true,
    sessionLifecycle: true,
    mcp: true,
    skills: false,
    modelSelection: opts.model !== undefined,
    toolPermissions: 'native',
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
        const result = await client.prompt({ text: buildPrompt(req) })
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

function buildPrompt(req: AgentRequest): string {
  if (req.system === undefined) return req.prompt
  return `${req.system}\n\n---\n\n${req.prompt}`
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
