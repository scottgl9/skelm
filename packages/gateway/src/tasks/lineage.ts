import type { RunStore } from '@skelm/core'

/** Maximum lineage depth walked in either direction, as a defensive cap. */
export const MAX_LINEAGE_DEPTH = 32

export interface RunRef {
  runId: string
  pipelineId: string
  status: string
  taskId?: string
}

export interface LineageNode extends RunRef {
  children: LineageNode[]
}

export interface LineageResult {
  runId: string
  ancestors: RunRef[]
  descendants: LineageNode[]
}

/**
 * Build the lineage of a run: its chain of ancestors (nearest first) and the
 * tree of descendants. Depth is capped at {@link MAX_LINEAGE_DEPTH} in both
 * directions so a corrupt parent cycle or a very deep tree cannot run the
 * query unbounded.
 */
export async function buildLineage(store: RunStore, runId: string): Promise<LineageResult | null> {
  const root = await store.getRun(runId)
  if (root === null) return null

  const ancestors: RunRef[] = []
  const seen = new Set<string>([runId])
  let cursor = root.parentRunId
  let depth = 0
  while (cursor !== undefined && depth < MAX_LINEAGE_DEPTH && !seen.has(cursor)) {
    const parent = await store.getRun(cursor)
    if (parent === null) break
    seen.add(cursor)
    ancestors.push(toRef(parent))
    cursor = parent.parentRunId
    depth += 1
  }

  const descendants = await buildDescendants(store, runId, 0, new Set([runId]))

  return { runId, ancestors, descendants }
}

async function buildDescendants(
  store: RunStore,
  parentRunId: string,
  depth: number,
  visited: Set<string>,
): Promise<LineageNode[]> {
  if (depth >= MAX_LINEAGE_DEPTH) return []
  const children: LineageNode[] = []
  // Lineage is reconstructed from tasks: each task records its parentRunId and
  // childRunId, so the children of a run are the child runs of its tasks.
  const tasks = await store.listTasks({ parentRunId })
  for (const task of tasks) {
    if (task.childRunId === undefined || visited.has(task.childRunId)) continue
    const child = await store.getRun(task.childRunId)
    if (child === null) continue
    visited.add(task.childRunId)
    children.push({
      ...toRef(child),
      children: await buildDescendants(store, task.childRunId, depth + 1, visited),
    })
  }
  return children
}

function toRef(run: {
  runId: string
  pipelineId: string
  status: string
  taskId?: string
}): RunRef {
  return {
    runId: run.runId,
    pipelineId: run.pipelineId,
    status: run.status,
    ...(run.taskId !== undefined && { taskId: run.taskId }),
  }
}
