/**
 * Deterministic test scaffolding for the coding-agent workflow.
 *
 * The agent step is driven by a SCRIPTED stub backend that records every
 * `AgentRequest` (prompt + resolved permission policy) and returns a fixed
 * answer. No real LLM, no network, and — crucially — no real repo mutation:
 * the stub never invokes a tool, so the fixture repo is read but never
 * written. This keeps CI deterministic while still letting tests assert the
 * permissions the workflow DECLARED reach the backend intact.
 */

import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  type BackendContext,
  BackendRegistry,
  type SkelmBackend,
} from '@skelm/core'

export interface ScriptedBackend extends SkelmBackend {
  /** Every run() request the workflow dispatched, in order. */
  readonly calls: AgentRequest[]
}

/**
 * A backend that advertises native tool-permission enforcement (matching the
 * real `@skelm/agent`) so the runtime threads the resolved policy onto the
 * request, then returns a canned summary. `replyText` is the agent's final
 * answer recorded as the step output.
 */
export function makeScriptedBackend(
  id = 'agent',
  replyText = 'Implemented the change; validation passed.',
): ScriptedBackend {
  const calls: AgentRequest[] = []
  const capabilities: BackendCapabilities = {
    prompt: true,
    streaming: false,
    sessionLifecycle: false,
    mcp: true,
    skills: true,
    modelSelection: false,
    toolPermissions: 'native',
  }
  const backend: ScriptedBackend = {
    id,
    capabilities,
    calls,
    async run(req: AgentRequest, _ctx: BackendContext): Promise<AgentResponse> {
      calls.push(req)
      return { text: replyText, stopReason: 'stop' }
    },
  }
  return backend
}

export function registryWith(backend: SkelmBackend): BackendRegistry {
  const reg = new BackendRegistry()
  reg.register(backend)
  return reg
}

/** Absolute path to the tiny fixture repo used by the end-to-end tests. */
export function fixtureRepo(): string {
  return new URL('./fixtures/repo', import.meta.url).pathname
}

/**
 * The resolved permission policy the runtime threaded onto the first agent
 * call. Throws if no call was recorded, so tests fail loudly rather than on a
 * non-null assertion.
 */
export function firstCallPolicy(backend: ScriptedBackend): import('@skelm/core').ResolvedPolicy {
  const call = backend.calls[0]
  if (call === undefined || call.permissions === undefined) {
    throw new Error('expected the agent step to dispatch with a resolved permission policy')
  }
  return call.permissions
}
