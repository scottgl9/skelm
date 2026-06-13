// WorkflowBuilder — the build/revise engine behind @skelm/workflow-builder.
//
// It inspects a project's workflows (read source + deriveWorkflowGraph),
// proposes new workflows or graph/source edits as REVIEWABLE patches through
// the gateway apply route (dry-run-default, codeOwned-preserving), runs
// `skelm validate`, and generates a package manifest. It never writes workflow
// source directly: every edit is funneled through the injected ApplyRoute so it
// stays audited and the round-trip's codeOwned guarantees hold.

import { relative } from 'node:path'
import {
  type GraphEdit,
  type SkelmBackend,
  type WorkflowGraph,
  deriveWorkflowGraph,
  isPersistentWorkflow,
} from '@skelm/core'
import type {
  ApplyRoute,
  InspectedWorkflow,
  ProjectSource,
  ReviewablePatch,
  ValidateRunner,
  ValidationOutcome,
} from './types.js'

export interface WorkflowBuilderOptions {
  /** Reads + discovers workflow source files, scoped to the project root. */
  project: ProjectSource
  /** Gateway round-trip apply route — the only write path. */
  applyRoute: ApplyRoute
  /** Runs `skelm validate <path>`. */
  validate: ValidateRunner
  /**
   * The agent backend driving conversational turns. Stubbed in tests. The
   * builder calls `run()`; a backend without `run` cannot author workflows.
   */
  agent: SkelmBackend
}

/** A workflow module loaded for in-process graph derivation. */
type LoadedWorkflow = Parameters<typeof deriveWorkflowGraph>[0]

export class WorkflowBuilder {
  private readonly project: ProjectSource
  private readonly applyRoute: ApplyRoute
  private readonly validate: ValidateRunner
  private readonly agent: SkelmBackend

  constructor(options: WorkflowBuilderOptions) {
    this.project = options.project
    this.applyRoute = options.applyRoute
    this.validate = options.validate
    this.agent = options.agent
  }

  /**
   * Inspect every workflow in the project: read its source and derive its
   * read-only graph. A `loader` resolves a source path to a workflow value;
   * the persistent entrypoint passes skelm's loader, tests pass a fake.
   */
  async inspect(
    loader: (path: string, source: string) => Promise<LoadedWorkflow>,
  ): Promise<readonly InspectedWorkflow[]> {
    const files = await this.project.listWorkflowFiles()
    const out: InspectedWorkflow[] = []
    for (const path of files) {
      const source = await this.project.readFile(path)
      const workflow = await loader(path, source)
      out.push({
        id: workflowId(workflow),
        path,
        relativePath: toPosix(relative(this.project.root, path)),
        source,
        graph: deriveWorkflowGraph(workflow),
      })
    }
    return out
  }

  /** Derive the read-only graph for a registered workflow via the apply route. */
  async graphOf(workflowId: string): Promise<WorkflowGraph> {
    return this.applyRoute.deriveGraph(workflowId)
  }

  /**
   * Propose graph edits as a reviewable patch. `dryRun` defaults to `true`, so
   * the proposal never writes unless a caller (after operator review)
   * explicitly opts into `dryRun: false`. Code-owned regions come back as a
   * refusal rather than a rewrite.
   */
  async proposeEdits(
    workflowId: string,
    edits: readonly GraphEdit[],
    options?: { dryRun?: boolean },
  ): Promise<ReviewablePatch> {
    const dryRun = options?.dryRun !== false
    return this.applyRoute.applyEdits(workflowId, edits, { dryRun })
  }

  /** Run `skelm validate` against a candidate workflow file. */
  async validateWorkflow(sourcePath: string): Promise<ValidationOutcome> {
    return this.validate(sourcePath)
  }

  /**
   * Drive one conversational turn: hand the user's message plus a compact
   * inventory of the project's workflows to the agent, and return its reply.
   * The agent decides whether to author, revise, or just answer; the privileged
   * actions it takes (apply edits, validate) route back through this builder's
   * injected ApplyRoute / ValidateRunner under the declared default-deny
   * permissions.
   */
  async turn(
    message: string,
    context: { inventory: readonly InspectedWorkflow[]; signal?: AbortSignal },
  ): Promise<string> {
    if (typeof this.agent.run !== 'function') {
      throw new Error(`backend ${this.agent.id} cannot author workflows: no run() method`)
    }
    const inventory = context.inventory
      .map((w) => `- ${w.id} (${w.relativePath}): ${w.graph.kind}, ${w.graph.nodes.length} node(s)`)
      .join('\n')
    const prompt =
      inventory.length > 0
        ? `Existing workflows in this project:\n${inventory}\n\nRequest:\n${message}`
        : `This project has no workflows yet.\n\nRequest:\n${message}`
    const response = await this.agent.run(
      { prompt, system: BUILDER_SYSTEM },
      { signal: context.signal ?? new AbortController().signal },
    )
    return response.text ?? ''
  }

  /**
   * Generate a `skelm.package.json` manifest body for the project's workflows.
   * Pure string production — the operator reviews and writes it. The first
   * workflow is mapped to the id `default` so `skelm run @scope/name` resolves.
   */
  generateManifest(input: {
    name: string
    version: string
    description?: string
    workflows: readonly { id?: string; entry: string; kind?: 'pipeline' | 'persistent' }[]
  }): string {
    const manifest = {
      name: input.name,
      version: input.version,
      ...(input.description !== undefined && { description: input.description }),
      license: 'MIT',
      skelm: {
        apiVersion: 1 as const,
        workflows: input.workflows.map((w, i) => ({
          id: w.id ?? (i === 0 ? 'default' : `workflow-${i}`),
          entry: toPosix(w.entry),
          ...(w.kind !== undefined && { kind: w.kind }),
        })),
      },
    }
    return `${JSON.stringify(manifest, null, 2)}\n`
  }
}

function workflowId(workflow: LoadedWorkflow): string {
  if (isPersistentWorkflow(workflow)) return workflow.id
  return (workflow as { id?: string }).id ?? 'unknown'
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join('/')
}

const BUILDER_SYSTEM = `You author and revise skelm workflows on behalf of an operator.

skelm is a TypeScript framework whose unit of work is a typed, inspectable pipeline.

Rules:
- The authored TypeScript is the single source of truth. Never rewrite a workflow file directly. Structural edits go through the gateway round-trip apply route as declarative GraphEdits (reorderSteps, setStepField, addStep, removeStep). The route is dry-run by default and refuses code-owned regions (inline run/while/on/items predicates) — those require manual TypeScript edits, which you surface as suggestions, not rewrites.
- For any agent() or infer() step, declare least-privilege AgentPermissions explicitly. Every permission field defaults to deny; grant only what the workflow needs.
- After proposing a new workflow or an edit, run "skelm validate" on the result and report the outcome. Fix and re-validate on error.
- Always present changes as a reviewable patch (a unified diff). Never imply a change was applied unless the apply route reported applied: true.
- Keep replies short and state the path of any file you propose.`
