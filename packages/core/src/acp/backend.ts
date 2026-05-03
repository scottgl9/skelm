// SkelmBackend wrapper around AcpClient.
//
// Spawns the configured ACP agent process, opens a session per call, sends
// the prompt, and aggregates the streaming response into an AgentResponse.
//
// `toolPermissions: 'unsupported'` for v0.1: this client does not yet
// negotiate per-call permission enforcement with the agent. A step that
// declares non-empty AgentPermissions against an ACP backend will fail at
// step start once the gateway-side enforcement contract lands; for now
// the runner accepts it and the backend forwards the policy as advisory
// metadata only. Customers who need tighter enforcement against ACP
// agents will want to gate at the workflow level (run claude with
// --dangerously-skip-permissions=false; configure copilot --add-dir;
// etc.).

import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  SkelmBackend,
} from '../backend.js'
import { AcpClient } from './client.js'

export interface AcpBackendOptions {
  /** Backend id. Defaults to 'acp' when only one ACP backend is registered. */
  id?: string
  /** Human-readable label for diagnostics. */
  label?: string
  /** Command and args used to spawn the ACP agent. */
  command: string
  args?: readonly string[]
  /** Optional working directory for the spawned agent. */
  cwd?: string
  /** Optional environment overlay for the agent process. */
  env?: NodeJS.ProcessEnv
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
    modelSelection: false,
    toolPermissions: 'unsupported',
  }

  const backend: SkelmBackend = {
    id: opts.id ?? 'acp',
    capabilities,
    async run(req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> {
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
        await client.newSession({ cwd: req.cwd ?? opts.cwd ?? process.cwd() })
        const result = await client.prompt({ text: buildPrompt(req) })
        return {
          text: result.text,
          stopReason: result.stopReason,
        }
      } finally {
        ctx.signal.removeEventListener('abort', onAbort)
        await client.stop()
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
