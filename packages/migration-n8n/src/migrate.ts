import { generateSkeleton } from './codegen.js'
import { generateFixture } from './fixture.js'
import { mapNodes, toStepId } from './mapping.js'
import { parseN8nWorkflow } from './parser.js'
import type { MigrateOptions, MigrationResult } from './types.js'

/** Derive a sanitized skelm pipeline id from an n8n workflow name. */
function pipelineIdFromName(name: string): string {
  const id = toStepId(name, new Set())
  return id.length > 0 ? id : 'imported'
}

/**
 * Import an n8n workflow JSON export into a skelm workflow skeleton.
 *
 * The single entrypoint: parse defensively at the boundary, map every node to
 * its skelm equivalent (or flag it unsupported), generate a reviewable
 * `pipeline(...)` source string, and — when the export carried sample
 * execution data — a test-fixture stub. The generated code is for human
 * review; it is never auto-activated.
 *
 * @param input Raw JSON text or an already-parsed n8n export value.
 * @throws {@link N8nImportError} when the export is malformed.
 */
export function migrateN8nWorkflow(input: unknown, options: MigrateOptions = {}): MigrationResult {
  const workflow = parseN8nWorkflow(input)
  const pipelineId = pipelineIdFromName(workflow.name)
  const nodes = mapNodes(workflow.nodes, options)
  const requiredIntegrations = [
    ...new Set(nodes.map((n) => n.integration).filter((v): v is string => Boolean(v))),
  ].sort()
  const unsupported = nodes.filter((n) => n.unsupported).map((n) => n.source.name)
  const source = generateSkeleton(pipelineId, nodes)
  const parsed = typeof input === 'string' ? safeJson(input) : input
  const fixture = generateFixture(pipelineId, parsed)
  return {
    pipelineId,
    nodes,
    requiredIntegrations,
    unsupported,
    source,
    ...(fixture !== undefined && { fixture }),
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
