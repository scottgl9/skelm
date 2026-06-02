import type { AgentmemoryHandleFactory } from '../backend.js'
import type { ApprovalGate, SecretResolver } from '../enforcement/index.js'
import type { AgentPermissions, NetworkPolicy, ResolvedPolicy } from '../permissions.js'
import type { RunStore, StateStore } from '../run-store.js'
import type { Skill } from '../skills.js'
import type { Context, Pipeline, RunStatus } from '../types.js'
import type { WorkspaceManager } from '../workspace.js'

/**
 * Mutable per-run wiring threaded through every step handler. Created once
 * in runPipeline and passed down so handlers don't need to close over
 * runPipeline locals — which is why they can live in their own files.
 */
export interface ExecutionRuntime {
  readonly workspaceManager: WorkspaceManager
  readonly stateStore: StateStore
  readonly store?: RunStore
  readonly defaultPermissions?: AgentPermissions
  readonly permissionProfiles?: Readonly<Record<string, AgentPermissions>>
  /**
   * Default backend id for `agent()` steps whose own `backend` is undefined.
   * Threaded by the gateway from the activated project's
   * `config.backends.agent` so each workflow inherits its project's choice
   * instead of falling back to "first registered backend with run()". A
   * workflow that explicitly declares `backend:` on the step still wins.
   */
  readonly defaultAgentBackend?: string
  /**
   * Default backend id for `infer()` steps whose own `backend` is undefined.
   * Same intent as `defaultAgentBackend`, sourced from the activated
   * project's `config.backends.infer`.
   */
  readonly defaultInferBackend?: string
  /**
   * Operator grant for the unrestricted bypass, supplied only by the trust
   * boundary (gateway). When true, an agent/code step whose resolved policy
   * requested the bypass runs `unrestricted`. Never derived from author input.
   */
  readonly unrestrictedGrant?: boolean
  readonly approvalGate?: ApprovalGate
  readonly skillSource?: (skillId: string) => Promise<Skill | null>
  readonly secretResolver?: SecretResolver
  readonly registerEgressToken?: (runId: string, stepId: string, policy: NetworkPolicy) => string
  readonly unregisterEgressToken?: (runId: string, stepId: string) => void
  readonly getProxyEnv?: (egressToken?: string) => Record<string, string> | undefined
  /**
   * Optional factory called per agent step to produce a gateway-wired
   * `AgentmemoryHandle`. The runner invokes it after resolving permissions
   * and before the backend `run()` call, then injects the returned handle
   * into `BackendContext.agentmemory`. Undefined disables agentmemory.
   */
  readonly agentmemoryHandleFactory?: AgentmemoryHandleFactory
  readonly pipelineRegistry?: (
    pipelineId: string,
  ) => Pipeline | undefined | Promise<Pipeline | undefined>
  /**
   * Upper bound on every agent step's resolved policy in this run. Set when the
   * run was started as a delegated child: it is the delegating agent's resolved
   * policy, and `resolvePermissions` results are intersected with it so a child
   * can never exceed the parent that delegated to it. Undefined for top-level runs.
   */
  readonly delegationCeiling?: ResolvedPolicy
  /**
   * Pipeline ids currently on the active delegation chain (oldest first),
   * seeded with the top-level pipeline id. A delegation whose target already
   * appears here is a cycle and is refused.
   */
  readonly delegationStack?: readonly string[]
  /** Number of delegations already taken to reach this run (0 at top level). */
  readonly delegationDepth?: number
  /** Cap on `delegationDepth`; defaults to `DEFAULT_MAX_DELEGATION_DEPTH`. */
  readonly maxDelegationDepth?: number
  readonly currentWorkspace: Context['workspace']
  /**
   * Directory used to resolve relative paths declared on steps. Mirrors
   * `pipeline.baseDir`; set by the runner from the running pipeline value.
   */
  readonly pipelineBaseDir?: string
  setCurrentWorkspace(workspace: Context['workspace']): void
  deferRunWorkspaceFinalizer(finalizer: (status: RunStatus) => Promise<void>): void
}
