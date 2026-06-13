import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  N8nImportError,
  generateSkeleton,
  mapNode,
  mapNodes,
  migrateN8nWorkflow,
  parseN8nWorkflow,
  ruleForType,
  toStepId,
} from '../src/index.js'
import type { N8nNode } from '../src/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

/** Assert a generated TS source string parses with no syntax errors. */
function assertParses(source: string): void {
  const sf = ts.createSourceFile('generated.ts', source, ts.ScriptTarget.ES2022, true)
  const syntactic = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
  expect(syntactic).toHaveLength(0)
}

const node = (over: Partial<N8nNode> & Pick<N8nNode, 'name' | 'type'>): N8nNode => over

describe('parser (boundary validation)', () => {
  it('rejects non-JSON strings with a typed error', () => {
    expect(() => parseN8nWorkflow('{ not json')).toThrow(N8nImportError)
  })

  it('rejects a missing nodes array with a typed error and field path', () => {
    let err: unknown
    try {
      parseN8nWorkflow(fixture('malformed.json'))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(N8nImportError)
    expect((err as N8nImportError).field).toBe('nodes')
  })

  it('rejects an empty nodes array', () => {
    expect(() => parseN8nWorkflow({ name: 'x', nodes: [] })).toThrow(N8nImportError)
  })

  it('rejects duplicate node names', () => {
    expect(() =>
      parseN8nWorkflow({
        nodes: [
          { name: 'A', type: 't' },
          { name: 'A', type: 't' },
        ],
      }),
    ).toThrow(/duplicate node name/)
  })

  it('tolerates unknown fields and keeps only known ones', () => {
    const wf = parseN8nWorkflow({
      name: 'wf',
      unknownTop: true,
      nodes: [{ name: 'A', type: 'n8n-nodes-base.set', credentials: { x: 1 }, weird: 9 }],
    })
    expect(wf.nodes[0]?.name).toBe('A')
    expect((wf.nodes[0] as unknown as Record<string, unknown>).weird).toBeUndefined()
  })
})

describe('node mappers', () => {
  it('maps the documented node types to the expected step kinds', () => {
    expect(ruleForType('n8n-nodes-base.httpRequest')?.kind).toBe('code')
    expect(ruleForType('n8n-nodes-base.webhook')?.triggerKind).toBe('webhook')
    expect(ruleForType('n8n-nodes-base.cron')?.triggerKind).toBe('cron')
    expect(ruleForType('n8n-nodes-base.scheduleTrigger')?.triggerKind).toBe('interval')
    expect(ruleForType('n8n-nodes-base.if')?.kind).toBe('branch')
    expect(ruleForType('n8n-nodes-base.switch')?.kind).toBe('branch')
    expect(ruleForType('n8n-nodes-base.merge')?.kind).toBe('parallel')
    expect(ruleForType('n8n-nodes-base.set')?.kind).toBe('code')
    expect(ruleForType('n8n-nodes-base.function')?.kind).toBe('code')
    expect(ruleForType('n8n-nodes-base.code')?.kind).toBe('code')
    expect(ruleForType('n8n-nodes-base.slack')?.integration).toBe('@skelm/integrations')
  })

  it('matches the node-type suffix case-insensitively across vendors', () => {
    expect(ruleForType('@community/n8n-nodes-foo.IF')?.kind).toBe('branch')
  })

  it('flags an unknown node type as unsupported, never dropping it', () => {
    const m = mapNode(node({ name: 'X', type: 'n8n-nodes-base.unknownThing' }), new Set())
    expect(m.unsupported).toBe(true)
    expect(m.kind).toBe('unsupported')
  })

  it('honors integration overrides', () => {
    const m = mapNode(node({ name: 'X', type: 'n8n-nodes-base.notion' }), new Set(), {
      integrationOverrides: { 'n8n-nodes-base.notion': '@acme/notion' },
    })
    expect(m.unsupported).toBe(false)
    expect(m.integration).toBe('@acme/notion')
  })

  it('produces unique, sanitized step ids', () => {
    const used = new Set<string>()
    expect(toStepId('HTTP Request', used)).toBe('httpRequest')
    expect(toStepId('HTTP Request', used)).toBe('httpRequest2')
    expect(toStepId('123 start', used)).toBe('step123Start')
  })

  it('orders mapped nodes by editor position deterministically', () => {
    const mapped = mapNodes([
      node({ name: 'B', type: 'n8n-nodes-base.set', position: [200, 0] }),
      node({ name: 'A', type: 'n8n-nodes-base.set', position: [0, 0] }),
    ])
    expect(mapped.map((m) => m.source.name)).toEqual(['A', 'B'])
  })

  it('omits disabled nodes so inert n8n steps do not become active', () => {
    const mapped = mapNodes([
      node({ name: 'Disabled', type: 'n8n-nodes-base.set', disabled: true, position: [0, 0] }),
      node({ name: 'Enabled', type: 'n8n-nodes-base.set', position: [10, 0] }),
      node({
        name: 'Unsupported Disabled',
        type: 'n8n-nodes-base.unknownThing',
        disabled: true,
        position: [20, 0],
      }),
    ])
    expect(mapped.map((m) => m.source.name)).toEqual(['Enabled'])
  })
})

describe('migrateN8nWorkflow — simple HTTP -> Set -> IF', () => {
  const result = migrateN8nWorkflow(fixture('simple.json'))

  it('maps cleanly with no unsupported nodes', () => {
    expect(result.unsupported).toEqual([])
  })

  it('lists the required integrations accurately', () => {
    expect(result.requiredIntegrations).toEqual(['@skelm/integration-http'])
  })

  it('emits a webhook trigger, a branch, and code steps', () => {
    expect(result.source).toContain('triggers:')
    expect(result.source).toContain('"webhook"')
    expect(result.source).toContain('branch(')
  })

  it('generates source that parses as TypeScript', () => {
    assertParses(result.source)
  })

  it('produces a fixture stub from the sample pinData', () => {
    expect(result.fixture).toBeDefined()
    expect(JSON.parse(result.fixture as string).input).toEqual({ orderId: 42, customer: 'acme' })
  })
})

describe('migrateN8nWorkflow — cron trigger', () => {
  const result = migrateN8nWorkflow(fixture('cron.json'))

  it('maps the Cron node to a cron trigger', () => {
    expect(result.source).toContain('"cron"')
    expect(result.source).toContain('triggers:')
  })

  it('requires the slack integration for the Slack node', () => {
    expect(result.requiredIntegrations).toEqual(['@skelm/integrations'])
  })

  it('generates parseable source with no fixture (no sample data)', () => {
    assertParses(result.source)
    expect(result.fixture).toBeUndefined()
  })
})

describe('migrateN8nWorkflow — unsupported node', () => {
  const result = migrateN8nWorkflow(fixture('unsupported.json'))

  it('flags unmapped nodes without dropping them', () => {
    expect(result.unsupported).toEqual(['Notion DB', 'Quantum Flux'])
    expect(result.source).toContain('UNSUPPORTED')
    expect(result.source).toContain('Notion DB')
    expect(result.source).toContain('Quantum Flux')
  })

  it('still generates parseable TypeScript', () => {
    assertParses(result.source)
  })
})

describe('migrateN8nWorkflow — malformed input', () => {
  it('throws a typed N8nImportError', () => {
    expect(() => migrateN8nWorkflow(fixture('malformed.json'))).toThrow(N8nImportError)
  })
})

describe('generateSkeleton', () => {
  it('imports exactly the builders it uses', () => {
    const src = generateSkeleton('p', mapNodes([node({ name: 'S', type: 'n8n-nodes-base.set' })]))
    expect(src).toContain('import { code, pipeline }')
  })

  it('emits a noop step when a workflow has only triggers', () => {
    const src = generateSkeleton(
      'p',
      mapNodes([node({ name: 'W', type: 'n8n-nodes-base.webhook' })]),
    )
    expect(src).toContain('import { code, pipeline }')
    assertParses(src)
  })
})
