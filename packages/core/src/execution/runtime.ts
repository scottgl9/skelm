import type { ApprovalGate, SecretResolver } from '../enforcement/index.js'
import type { AgentPermissions, NetworkPolicy } from '../permissions.js'
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
  readonly approvalGate?: ApprovalGate
  readonly skillSource?: (skillId: string) => Promise<Skill | null>
  readonly secretResolver?: SecretResolver
  readonly registerEgressToken?: (runId: string, stepId: string, policy: NetworkPolicy) => string
  readonly unregisterEgressToken?: (runId: string, stepId: string) => void
  readonly getProxyEnv?: (egressToken?: string) => Record<string, string> | undefined
  readonly pipelineRegistry?: (
    pipelineId: string,
  ) => Pipeline | undefined | Promise<Pipeline | undefined>
  readonly currentWorkspace: Context['workspace']
  /**
   * Directory used to resolve relative paths declared on steps. Mirrors
   * `pipeline.baseDir`; set by the runner from the running pipeline value.
   */
  readonly pipelineBaseDir?: string
  setCurrentWorkspace(workspace: Context['workspace']): void
  deferRunWorkspaceFinalizer(finalizer: (status: RunStatus) => Promise<void>): void
}
