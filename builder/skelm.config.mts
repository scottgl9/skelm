import { createCodexBackend } from '@skelm/codex'
import { createRemoteTriggerSource } from '@skelm/integrations'
import { createPiSdkBackend } from '@skelm/pi'
import { createRoutingBackend, defineWorkflowConfig } from 'skelm'
import { createTerminalFrontend } from './chatui-frontend.mts'

// Backend selection with native runtime fallback. Codex is the default; if a
// codex turn errors (no `codex login` / CODEX_API_KEY, the CLI is missing, or an
// upstream failure), skelm's createRoutingBackend falls over to the in-process
// Pi backend pointed at a local OpenAI-compatible endpoint. This is true
// per-request failover, not a static load-time probe. Set SKELM_BUILDER_BACKEND
// to 'codex' or 'pi' to pin one backend and skip the fallback.
// `osSandbox: false` runs codex with no OS sandbox (the gateway is the trust
// boundary, same posture as the in-process Pi failover below). Set
// SKELM_CODEX_OS_SANDBOX=0 in environments where codex's user-namespace /
// bubblewrap sandbox can't initialize (many CI runners + containers) — there,
// the default sandbox silently blocks every file write and shell command, so
// the builder can't author files. Leave it set (the default) wherever codex's
// sandbox works so codex keeps enforcing it natively.
const codex = createCodexBackend({
  id: 'codex',
  osSandbox: process.env.SKELM_CODEX_OS_SANDBOX !== '0',
})
const pi = createPiSdkBackend({
  id: 'pi',
  baseUrl: process.env.OPENAI_BASE_URL ?? 'http://localhost:8000/v1',
  apiKey: process.env.OPENAI_API_KEY ?? 'unused',
  model: process.env.OPENAI_MODEL ?? 'qwen36',
})
const pin = process.env.SKELM_BUILDER_BACKEND
const agentBackend =
  pin === 'pi'
    ? pi
    : pin === 'codex'
      ? codex
      : createRoutingBackend({
          id: 'builder-agent',
          primary: codex,
          failover: [pi],
          onFailover: (info) =>
            console.error(`[builder] ${info.from} unavailable — falling over to ${info.to}`),
        })

export default defineWorkflowConfig({
  registries: {
    workflows: { glob: '*.workflow.{mts,ts}' },
  },
  // Only the agent role is wired; `openai: undefined` suppresses the
  // framework-default openai backend (which would demand OPENAI_API_KEY).
  backends: { agent: agentBackend.id, openai: undefined },
  instances: [agentBackend],
  triggerSources: [
    {
      id: 'tui',
      // Terminal transport: headless on the gateway, the CLI host renders the
      // Ink frontend. `skelm builder` activates this project and hosts it.
      driver: createRemoteTriggerSource({
        transport: 'tui',
        frontend: createTerminalFrontend({
          banner: 'skelm builder — describe a workflow to author it (Ctrl-C to exit)',
        }),
      }),
    },
  ],
  defaults: {
    // The builder runs as a PERSISTENT workflow: each chat turn fires through
    // the gateway's triggered path, which applies this config-level permission
    // ceiling and INTERSECTS it with the agent's declared permissions. skelm is
    // default-deny, so without raising the ceiling here the agent's grants in
    // builder.workflow.mts (fsWrite, exec, skill, network) would collapse to
    // nothing — the builder couldn't write files, run validation, or reach its backend. This
    // ceiling mirrors the agent's least-privilege needs; it is NOT an
    // unrestricted bypass. (A one-shot `skelm run` doesn't apply this ceiling,
    // which is why the gap only bites the persistent/triggered path.)
    permissions: {
      networkEgress: 'allow',
      allowedExecutables: ['skelm', 'node', 'bash'],
      allowedSkills: ['skelm'],
      fsRead: ['./'],
      fsWrite: ['./'],
    },
  },
})
