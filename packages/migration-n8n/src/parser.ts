import { N8nImportError } from './errors.js'
import type { N8nConnections, N8nNode, N8nWorkflow } from './types.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNode(raw: unknown, index: number): N8nNode {
  if (!isObject(raw)) {
    throw new N8nImportError(`node at index ${index} is not an object`, `nodes[${index}]`)
  }
  const name = raw.name
  if (typeof name !== 'string' || name.length === 0) {
    throw new N8nImportError(
      `node at index ${index} is missing a string "name"`,
      `nodes[${index}].name`,
    )
  }
  const type = raw.type
  if (typeof type !== 'string' || type.length === 0) {
    throw new N8nImportError(`node "${name}" is missing a string "type"`, `nodes[${index}].type`)
  }
  // Tolerate unknown fields: we keep only the ones the mapper reads.
  const node: {
    name: string
    type: string
    typeVersion?: number
    parameters?: Record<string, unknown>
    position?: [number, number]
    disabled?: boolean
  } = { name, type }
  if (typeof raw.typeVersion === 'number') node.typeVersion = raw.typeVersion
  if (isObject(raw.parameters)) node.parameters = raw.parameters
  if (
    Array.isArray(raw.position) &&
    raw.position.length === 2 &&
    typeof raw.position[0] === 'number' &&
    typeof raw.position[1] === 'number'
  ) {
    node.position = [raw.position[0], raw.position[1]]
  }
  if (typeof raw.disabled === 'boolean') node.disabled = raw.disabled
  return node
}

function parseConnections(raw: unknown): N8nConnections {
  // Connections are advisory for ordering; an absent or malformed map degrades
  // to "no connections" rather than failing the whole import.
  if (!isObject(raw)) return {}
  const out: Record<
    string,
    Record<string, Array<Array<{ node: string; type?: string; index?: number }>>>
  > = {}
  for (const [source, outputs] of Object.entries(raw)) {
    if (!isObject(outputs)) continue
    const byKind: Record<string, Array<Array<{ node: string; type?: string; index?: number }>>> = {}
    for (const [kind, slots] of Object.entries(outputs)) {
      if (!Array.isArray(slots)) continue
      const parsedSlots: Array<Array<{ node: string; type?: string; index?: number }>> = []
      for (const slot of slots) {
        if (!Array.isArray(slot)) {
          parsedSlots.push([])
          continue
        }
        const targets: Array<{ node: string; type?: string; index?: number }> = []
        for (const target of slot) {
          if (isObject(target) && typeof target.node === 'string') {
            const t: { node: string; type?: string; index?: number } = { node: target.node }
            if (typeof target.type === 'string') t.type = target.type
            if (typeof target.index === 'number') t.index = target.index
            targets.push(t)
          }
        }
        parsedSlots.push(targets)
      }
      byKind[kind] = parsedSlots
    }
    out[source] = byKind
  }
  return out
}

/**
 * Parse and validate an n8n workflow export at the system boundary.
 *
 * Accepts either a raw JSON string or an already-parsed value. Validation is
 * intentionally minimal — a real n8n export carries dozens of fields we ignore
 * — but the invariants the mapper depends on (an object with a non-empty
 * `nodes` array, each node a named, typed object) are enforced strictly. Any
 * violation throws {@link N8nImportError} with the offending field path.
 */
export function parseN8nWorkflow(input: unknown): N8nWorkflow {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch (err) {
      throw new N8nImportError(
        `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  if (!isObject(value)) {
    throw new N8nImportError('workflow export must be a JSON object')
  }
  if (!Array.isArray(value.nodes)) {
    throw new N8nImportError('workflow export is missing a "nodes" array', 'nodes')
  }
  if (value.nodes.length === 0) {
    throw new N8nImportError('workflow export has an empty "nodes" array', 'nodes')
  }
  const nodes = value.nodes.map((raw, i) => parseNode(raw, i))
  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.name)) {
      throw new N8nImportError(`duplicate node name "${node.name}"`, 'nodes')
    }
    seen.add(node.name)
  }
  const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : 'imported'
  return { name, nodes, connections: parseConnections(value.connections) }
}
