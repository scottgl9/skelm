import type {
  MappedNode,
  MigrateOptions,
  N8nNode,
  SkelmStepKind,
  SkelmTriggerKind,
} from './types.js'

interface MappingRule {
  /** Suffix of the n8n node `type` after `n8n-nodes-base.` (case-insensitive). */
  readonly match: string
  readonly kind: SkelmStepKind
  readonly triggerKind?: SkelmTriggerKind
  /** skelm integration package the mapping needs, when one exists. */
  readonly integration?: string
  readonly note: string
}

/**
 * The supported node→step mapping table.
 *
 * Matching is by the node-type suffix after the leading vendor prefix
 * (`n8n-nodes-base.`), compared case-insensitively, so `n8n-nodes-base.if`
 * and a community `@scope/n8n-nodes-foo.if` both match the `if` rule. The
 * first matching rule wins; order is therefore significant only where two
 * suffixes would otherwise overlap (none do today).
 *
 * Integrations are referenced only where a first-party skelm package exists
 * (`@skelm/integrations` ships github / slack / telegram / ms-graph / matrix).
 * Everything else maps to a `code` step the author fills in, or — when no
 * mapping exists at all — is flagged unsupported.
 */
const RULES: readonly MappingRule[] = [
  // Triggers
  { match: 'webhook', kind: 'trigger', triggerKind: 'webhook', note: 'Webhook → webhook trigger' },
  {
    match: 'cron',
    kind: 'trigger',
    triggerKind: 'cron',
    note: 'Cron → cron trigger (offered, disabled until enabled)',
  },
  {
    match: 'scheduletrigger',
    kind: 'trigger',
    triggerKind: 'interval',
    note: 'Schedule Trigger → interval/cron trigger',
  },
  {
    match: 'intervaltrigger',
    kind: 'trigger',
    triggerKind: 'interval',
    note: 'Interval Trigger → interval trigger',
  },
  // Control flow
  { match: 'if', kind: 'branch', note: 'IF → branch (two cases)' },
  { match: 'switch', kind: 'branch', note: 'Switch → branch (case per output)' },
  { match: 'merge', kind: 'parallel', note: 'Merge → parallel + merge in finalize' },
  // Code-ish
  { match: 'set', kind: 'code', note: 'Set → code step assigning fields' },
  { match: 'function', kind: 'code', note: 'Function → code step (port JS by hand)' },
  { match: 'functionitem', kind: 'code', note: 'Function Item → code step (port JS by hand)' },
  { match: 'code', kind: 'code', note: 'Code → code step (port JS by hand)' },
  { match: 'noop', kind: 'code', note: 'NoOp → pass-through code step' },
  // HTTP
  {
    match: 'httprequest',
    kind: 'code',
    integration: '@skelm/integration-http',
    note: 'HTTP Request → invoke @skelm/integration-http (or a fetch code step)',
  },
  // Integrations with a first-party skelm package
  {
    match: 'slack',
    kind: 'invoke',
    integration: '@skelm/integrations',
    note: 'Slack → @skelm/integrations slack',
  },
  {
    match: 'telegram',
    kind: 'invoke',
    integration: '@skelm/integrations',
    note: 'Telegram → @skelm/integrations telegram',
  },
  {
    match: 'github',
    kind: 'invoke',
    integration: '@skelm/integrations',
    note: 'GitHub → @skelm/integrations github',
  },
  {
    match: 'microsoftgraph',
    kind: 'invoke',
    integration: '@skelm/integrations',
    note: 'Microsoft Graph → @skelm/integrations ms-graph',
  },
  // LLM-ish
  { match: 'openai', kind: 'infer', note: 'OpenAI → infer step (set backend/model)' },
  {
    match: 'agent',
    kind: 'agent',
    note: 'AI Agent → agent step (declare permissions; default-deny)',
  },
]

const PREFIX_RE = /^[^.]*\./

/** Strip the vendor prefix and lower-case for matching. */
function nodeTypeKey(type: string): string {
  return type.replace(PREFIX_RE, '').toLowerCase()
}

/**
 * Turn an n8n node name into a safe, unique TypeScript step id. n8n names are
 * free-form ("HTTP Request 2"); we slugify to camel-ish identifiers and append
 * a numeric suffix on collision so generated code always has unique step ids.
 */
export function toStepId(name: string, used: Set<string>): string {
  let base = name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((word, i) =>
      i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join('')
  if (base.length === 0 || /^[0-9]/.test(base)) base = `step${base}`
  let id = base
  let n = 1
  while (used.has(id)) {
    id = `${base}${++n}`
  }
  used.add(id)
  return id
}

/** Look up the mapping rule for a single node type, if any. */
export function ruleForType(type: string): MappingRule | undefined {
  const key = nodeTypeKey(type)
  return RULES.find((r) => r.match === key)
}

/** Map a single n8n node to its skelm step equivalent. */
export function mapNode(
  node: N8nNode,
  used: Set<string>,
  options: MigrateOptions = {},
): MappedNode {
  const stepId = toStepId(node.name, used)
  const override = options.integrationOverrides?.[node.type]
  if (override) {
    return {
      source: node,
      stepId,
      kind: 'invoke',
      integration: override,
      note: `Override → invoke ${override}`,
      unsupported: false,
    }
  }
  const rule = ruleForType(node.type)
  if (!rule) {
    return {
      source: node,
      stepId,
      kind: 'unsupported',
      note: `No skelm mapping for n8n node type "${node.type}"`,
      unsupported: true,
    }
  }
  return {
    source: node,
    stepId,
    kind: rule.kind,
    ...(rule.triggerKind !== undefined && { triggerKind: rule.triggerKind }),
    ...(rule.integration !== undefined && { integration: rule.integration }),
    note: rule.note,
    unsupported: false,
  }
}

/** Map every node in a workflow, in deterministic (editor-position) order. */
export function mapNodes(
  nodes: readonly N8nNode[],
  options: MigrateOptions = {},
): readonly MappedNode[] {
  const ordered = nodes
    .filter((node) => node.disabled !== true)
    .sort((a, b) => {
      const ax = a.position?.[0] ?? 0
      const bx = b.position?.[0] ?? 0
      if (ax !== bx) return ax - bx
      const ay = a.position?.[1] ?? 0
      const by = b.position?.[1] ?? 0
      if (ay !== by) return ay - by
      return a.name.localeCompare(b.name)
    })
  const used = new Set<string>()
  return ordered.map((node) => mapNode(node, used, options))
}
