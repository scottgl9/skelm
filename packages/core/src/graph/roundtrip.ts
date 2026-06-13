// Graph-edit → TypeScript-source round-trip.
//
// `applyGraphEdits` turns a small set of SAFE, DECLARATIVE graph edits into a
// reviewable patch against the authored workflow source. The TypeScript source
// stays the single source of truth: edits are applied as targeted text splices
// over the parsed AST, never as a full re-emit, so formatting and comments
// outside the edited spans are preserved byte-for-byte.
//
// HARD RULE: author code (inline `run` functions, `branch.on` / `loop.while`
// predicates, `forEach` selectors/factories — anything `deriveWorkflowGraph`
// flags `codeOwned`) is NEVER rewritten. An edit that targets such a region is
// refused with `{ ok: false, reason: 'code-owned' }`, and every successful
// result is verified to carry each author function of the input source
// byte-identically (relocation by `reorderSteps` is the only allowed change).

import { createRequire } from 'node:module'
import type tsNS from 'typescript'

type TS = typeof tsNS

/** A JSON-serializable literal accepted as a `setStepField` / spec value. */
export type GraphEditValue =
  | string
  | number
  | boolean
  | null
  | GraphEditValue[]
  | { [key: string]: GraphEditValue }

/**
 * A step that can be expressed purely declaratively and therefore generated
 * into source. Steps that require author code (inline `code.run`, predicates,
 * factories) are intentionally NOT representable.
 */
export type DeclarativeStepSpec =
  | { kind: 'wait'; id: string; message?: string; timeoutMs?: number }
  | { kind: 'invoke'; id: string; pipelineId: string; input?: GraphEditValue }
  | {
      kind: 'infer'
      id: string
      prompt: string
      backend?: string
      model?: string
      system?: string
      temperature?: number
      maxTokens?: number
    }
  | {
      kind: 'agent'
      id: string
      prompt: string
      backend?: string
      system?: string
      maxTurns?: number
      timeoutMs?: number
    }
  | { kind: 'code'; id: string; module: string; export?: string; timeoutMs?: number }

/** A single safe, declarative edit against a workflow's source. */
export type GraphEdit =
  | { kind: 'reorderSteps'; pipelineId: string; orderedStepIds: readonly string[] }
  | { kind: 'setStepField'; stepId: string; field: string; value: GraphEditValue }
  | { kind: 'addStep'; afterStepId?: string; step: DeclarativeStepSpec }
  | { kind: 'removeStep'; stepId: string }

export type GraphEditFailureReason = 'code-owned' | 'unsupported' | 'invalid-source' | 'not-found'

export type GraphEditResult =
  | { ok: true; source: string; diff: string }
  | { ok: false; reason: GraphEditFailureReason; detail: string }

type Failure = Extract<GraphEditResult, { ok: false }>

const WORKFLOW_BUILDERS = new Set(['pipeline', 'persistentWorkflow'])
const STEP_BUILDERS = new Set([
  'code',
  'infer',
  'agent',
  'parallel',
  'branch',
  'forEach',
  'loop',
  'wait',
  'pipelineStep',
  'invoke',
  'idempotent',
  'check',
])
// Builders whose graph node is codeOwned regardless of fields.
const CODE_OWNED_BUILDERS = new Set(['branch', 'forEach', 'loop', 'check'])
// Fields that hold (or may hold) author code; never settable.
const CODE_OWNED_FIELDS = new Set([
  'run',
  'on',
  'while',
  'items',
  'step',
  'steps',
  'cases',
  'default',
  'when',
  'finalize',
  'pipeline',
])
const SETTABLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  code: ['module', 'export', 'timeoutMs'],
  infer: ['backend', 'model', 'temperature', 'maxTokens', 'prompt', 'system'],
  agent: ['backend', 'maxTurns', 'timeoutMs', 'prompt', 'system'],
  wait: ['message', 'timeoutMs'],
  invoke: ['pipelineId', 'input'],
  idempotent: ['key', 'ttlMs'],
}
const SPEC_FIELDS: Readonly<
  Record<string, Readonly<Record<string, 'string' | 'number' | 'json'>>>
> = {
  wait: { message: 'string', timeoutMs: 'number' },
  invoke: { pipelineId: 'string', input: 'json' },
  infer: {
    prompt: 'string',
    backend: 'string',
    model: 'string',
    system: 'string',
    temperature: 'number',
    maxTokens: 'number',
  },
  agent: {
    prompt: 'string',
    backend: 'string',
    system: 'string',
    maxTurns: 'number',
    timeoutMs: 'number',
  },
  code: { module: 'string', export: 'string', timeoutMs: 'number' },
}
const SPEC_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  wait: [],
  invoke: ['pipelineId'],
  infer: ['prompt'],
  agent: ['prompt'],
  code: ['module'],
}
const IMPORT_SPECIFIERS = new Set(['skelm', '@skelm/core'])

let tsModuleCache: TS | null | undefined
function loadTs(): TS | undefined {
  if (tsModuleCache !== undefined) return tsModuleCache ?? undefined
  try {
    tsModuleCache = createRequire(import.meta.url)('typescript') as TS
  } catch {
    tsModuleCache = null
  }
  return tsModuleCache ?? undefined
}

function fail(reason: GraphEditFailureReason, detail: string): Failure {
  return { ok: false, reason, detail }
}

/**
 * Apply a sequence of declarative graph edits to workflow TypeScript source.
 *
 * Returns the modified source plus a unified diff for preview, or a typed
 * refusal. Pure: never touches the filesystem; callers (the gateway) own
 * validation-by-loading, the atomic write, and the audit trail.
 */
export function applyGraphEdits(source: string, edits: readonly GraphEdit[]): GraphEditResult {
  const ts = loadTs()
  if (ts === undefined) {
    return fail('unsupported', 'the "typescript" package is not available for AST editing')
  }
  if (typeof source !== 'string' || source.length === 0) {
    return fail('invalid-source', 'source must be a non-empty string')
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    return fail('unsupported', 'edits must be a non-empty array')
  }
  if (parseErrors(ts, source)) {
    return fail('invalid-source', 'source does not parse as TypeScript')
  }
  let current = source
  for (const [index, edit] of edits.entries()) {
    const applied = applyOne(ts, current, edit, index)
    if (typeof applied !== 'string') return applied
    current = applied
  }
  const violation = verifyEquivalence(ts, source, current)
  if (violation !== undefined) return fail('unsupported', violation)
  return { ok: true, source: current, diff: unifiedDiff(source, current) }
}

function applyOne(ts: TS, source: string, edit: GraphEdit, index: number): string | Failure {
  if (typeof edit !== 'object' || edit === null) {
    return fail('unsupported', `edits[${index}] must be an object`)
  }
  const sf = ts.createSourceFile('workflow.ts', source, ts.ScriptTarget.Latest, true)
  switch (edit.kind) {
    case 'reorderSteps':
      return applyReorder(ts, sf, source, edit, index)
    case 'setStepField':
      return applySetField(ts, sf, source, edit, index)
    case 'addStep':
      return applyAddStep(ts, sf, source, edit, index)
    case 'removeStep':
      return applyRemoveStep(ts, sf, source, edit, index)
    default:
      return fail(
        'unsupported',
        `edits[${index}] has unknown kind "${String((edit as { kind?: unknown }).kind)}"`,
      )
  }
}

// ─── AST helpers ────────────────────────────────────────────────────────────

interface BuilderCall {
  name: string
  call: tsNS.CallExpression
  obj: tsNS.ObjectLiteralExpression
  id: string | undefined
}

interface WorkflowCall extends BuilderCall {
  stepsArray: tsNS.ArrayLiteralExpression | undefined
}

interface StepCallMatch {
  step: BuilderCall
  codeOwnedAncestor: BuilderCall | undefined
}

function walk(ts: TS, node: tsNS.Node, visit: (n: tsNS.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(ts, child, visit))
}

function parseErrors(ts: TS, source: string): boolean {
  const sf = ts.createSourceFile('workflow.ts', source, ts.ScriptTarget.Latest, true)
  // parseDiagnostics is internal but stable; a Program would be far heavier.
  const diags = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics
  return Array.isArray(diags) && diags.length > 0
}

function propertyName(ts: TS, name: tsNS.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return undefined
}

function getProperty(
  ts: TS,
  obj: tsNS.ObjectLiteralExpression,
  name: string,
): tsNS.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propertyName(ts, prop.name) === name) return prop
  }
  return undefined
}

function literalString(ts: TS, expr: tsNS.Expression | undefined): string | undefined {
  if (
    expr !== undefined &&
    (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
  ) {
    return expr.text
  }
  return undefined
}

function asBuilderCall(
  ts: TS,
  node: tsNS.Node,
  names: ReadonlySet<string>,
): BuilderCall | undefined {
  if (!ts.isCallExpression(node)) return undefined
  if (!ts.isIdentifier(node.expression) || !names.has(node.expression.text)) return undefined
  const arg = node.arguments[0]
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined
  return {
    name: node.expression.text,
    call: node,
    obj: arg,
    id: literalString(ts, getProperty(ts, arg, 'id')?.initializer),
  }
}

function collectStepCalls(ts: TS, sf: tsNS.SourceFile): BuilderCall[] {
  const out: BuilderCall[] = []
  walk(ts, sf, (node) => {
    const found = asBuilderCall(ts, node, STEP_BUILDERS)
    if (found !== undefined) out.push(found)
  })
  return out
}

function collectStepMatches(
  ts: TS,
  node: tsNS.Node,
  out: StepCallMatch[],
  codeOwnedAncestor?: BuilderCall,
): void {
  const found = asBuilderCall(ts, node, STEP_BUILDERS)
  if (found !== undefined) {
    out.push({ step: found, codeOwnedAncestor })
    const nextAncestor = codeOwnedAncestor ?? (isCodeOwnedStep(ts, found) ? found : undefined)
    ts.forEachChild(node, (child) => collectStepMatches(ts, child, out, nextAncestor))
    return
  }
  ts.forEachChild(node, (child) => collectStepMatches(ts, child, out, codeOwnedAncestor))
}

function collectWorkflowCalls(ts: TS, sf: tsNS.SourceFile): WorkflowCall[] {
  const out: WorkflowCall[] = []
  walk(ts, sf, (node) => {
    const found = asBuilderCall(ts, node, WORKFLOW_BUILDERS)
    if (found === undefined) return
    const steps = getProperty(ts, found.obj, 'steps')?.initializer
    out.push({
      ...found,
      stepsArray: steps !== undefined && ts.isArrayLiteralExpression(steps) ? steps : undefined,
    })
  })
  return out
}

function findStepCall(
  ts: TS,
  sf: tsNS.SourceFile,
  stepId: string,
  index: number,
): BuilderCall | Failure {
  const matches: StepCallMatch[] = []
  collectStepMatches(ts, sf, matches)
  const targeted = matches.filter((match) => match.step.id === stepId)
  if (targeted.length === 0) {
    return fail('not-found', `edits[${index}]: no step builder call with id "${stepId}" was found`)
  }
  const editable = targeted.filter((match) => match.codeOwnedAncestor === undefined)
  if (editable.length === 0) {
    const owner = targeted[0]?.codeOwnedAncestor
    return fail(
      'code-owned',
      `edits[${index}]: step "${stepId}" is nested inside code-owned step "${owner?.id ?? owner?.name ?? 'unknown'}"; edit the TypeScript source manually`,
    )
  }
  if (targeted.length > 1) {
    return fail('unsupported', `edits[${index}]: step id "${stepId}" is ambiguous in source`)
  }
  return editable[0]?.step as BuilderCall
}

function containsFunction(ts: TS, node: tsNS.Node): boolean {
  let found = false
  walk(ts, node, (n) => {
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) {
      found = true
    }
  })
  return found
}

/** True when the step's derived graph node would be `codeOwned`. */
function isCodeOwnedStep(ts: TS, step: BuilderCall): boolean {
  if (CODE_OWNED_BUILDERS.has(step.name)) return true
  return step.name === 'code' && getProperty(ts, step.obj, 'run') !== undefined
}

function lineIndent(source: string, position: number): string {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1
  const match = /^[ \t]*/.exec(source.slice(lineStart, position))
  return match === null ? '' : match[0]
}

interface ArrayLayout {
  multiline: boolean
  indent: string
  closeIndent: string
  trailingComma: boolean
}

function arrayLayout(
  ts: TS,
  sf: tsNS.SourceFile,
  source: string,
  arr: tsNS.ArrayLiteralExpression,
): ArrayLayout {
  const open = arr.getStart(sf)
  const startLine = sf.getLineAndCharacterOfPosition(open).line
  const endLine = sf.getLineAndCharacterOfPosition(arr.end).line
  const first = arr.elements[0]
  const last = arr.elements[arr.elements.length - 1]
  const between = last === undefined ? '' : source.slice(last.end, arr.end - 1)
  return {
    multiline: startLine !== endLine,
    indent: first === undefined ? '' : lineIndent(source, first.getStart(sf)),
    closeIndent: lineIndent(source, arr.end - 1),
    trailingComma: between.includes(','),
  }
}

/**
 * Refuse edits when the steps array carries comments between elements: a
 * splice-based rewrite would silently drop them, which breaks the "equivalent
 * except for the intended edit" guarantee.
 */
function interElementResidue(
  ts: TS,
  sf: tsNS.SourceFile,
  source: string,
  arr: tsNS.ArrayLiteralExpression,
): boolean {
  let cursor = arr.getStart(sf) + 1
  let residue = ''
  for (const el of arr.elements) {
    residue += source.slice(cursor, el.getStart(sf))
    cursor = el.end
  }
  residue += source.slice(cursor, arr.end - 1)
  return /[^\s,]/.test(residue)
}

function splice(source: string, start: number, end: number, text: string): string {
  return source.slice(0, start) + text + source.slice(end)
}

// ─── reorderSteps ───────────────────────────────────────────────────────────

function applyReorder(
  ts: TS,
  sf: tsNS.SourceFile,
  source: string,
  edit: Extract<GraphEdit, { kind: 'reorderSteps' }>,
  index: number,
): string | Failure {
  if (typeof edit.pipelineId !== 'string' || !Array.isArray(edit.orderedStepIds)) {
    return fail(
      'unsupported',
      `edits[${index}]: reorderSteps requires pipelineId and orderedStepIds`,
    )
  }
  const workflow = collectWorkflowCalls(ts, sf).find((w) => w.id === edit.pipelineId)
  if (workflow === undefined) {
    return fail('not-found', `edits[${index}]: no pipeline with id "${edit.pipelineId}" was found`)
  }
  const arr = workflow.stepsArray
  if (arr === undefined) {
    return fail(
      'unsupported',
      `edits[${index}]: pipeline "${edit.pipelineId}" has no steps array literal`,
    )
  }
  if (interElementResidue(ts, sf, source, arr)) {
    return fail(
      'unsupported',
      `edits[${index}]: steps array carries comments that a reorder cannot preserve`,
    )
  }
  const byId = new Map<string, string>()
  for (const el of arr.elements) {
    const step = asBuilderCall(ts, el, STEP_BUILDERS)
    if (step?.id === undefined) {
      return fail(
        'unsupported',
        `edits[${index}]: a step element has no literal id and cannot be reordered`,
      )
    }
    if (byId.has(step.id)) {
      return fail('unsupported', `edits[${index}]: duplicate step id "${step.id}" in steps array`)
    }
    byId.set(step.id, source.slice(el.getStart(sf), el.end))
  }
  const ordered = [...edit.orderedStepIds]
  if (
    ordered.length !== byId.size ||
    new Set(ordered).size !== ordered.length ||
    !ordered.every((id) => typeof id === 'string' && byId.has(id))
  ) {
    return fail(
      'unsupported',
      `edits[${index}]: orderedStepIds must be a permutation of the existing step ids [${[...byId.keys()].join(', ')}]`,
    )
  }
  const texts = ordered.map((id) => byId.get(id) as string)
  const layout = arrayLayout(ts, sf, source, arr)
  const inner = layout.multiline
    ? `\n${texts.map((t) => layout.indent + t).join(',\n')}${layout.trailingComma ? ',' : ''}\n${layout.closeIndent}`
    : texts.join(', ')
  return splice(source, arr.getStart(sf) + 1, arr.end - 1, inner)
}

// ─── setStepField ───────────────────────────────────────────────────────────

function applySetField(
  ts: TS,
  sf: tsNS.SourceFile,
  source: string,
  edit: Extract<GraphEdit, { kind: 'setStepField' }>,
  index: number,
): string | Failure {
  if (typeof edit.stepId !== 'string' || typeof edit.field !== 'string') {
    return fail('unsupported', `edits[${index}]: setStepField requires stepId and field`)
  }
  if (!isGraphEditValue(edit.value)) {
    return fail('unsupported', `edits[${index}]: value must be a JSON-serializable literal`)
  }
  const step = findStepCall(ts, sf, edit.stepId, index)
  if ('ok' in step) return step
  if (CODE_OWNED_FIELDS.has(edit.field)) {
    return fail(
      'code-owned',
      `edits[${index}]: field "${edit.field}" holds author code and cannot be set declaratively`,
    )
  }
  if (isCodeOwnedStep(ts, step)) {
    return fail(
      'code-owned',
      `edits[${index}]: step "${edit.stepId}" (${step.name}) is code-owned; edit the TypeScript source manually`,
    )
  }
  if (edit.field === 'id') {
    return fail(
      'unsupported',
      `edits[${index}]: renaming a step id may break ctx.steps references; edit the source manually`,
    )
  }
  const allowed = SETTABLE_FIELDS[step.name]
  if (allowed === undefined || !allowed.includes(edit.field)) {
    return fail(
      'unsupported',
      `edits[${index}]: field "${edit.field}" is not declaratively settable on a ${step.name} step`,
    )
  }
  const existing = getProperty(ts, step.obj, edit.field)
  const literal = serializeLiteral(edit.value)
  if (existing !== undefined) {
    if (containsFunction(ts, existing.initializer)) {
      return fail(
        'code-owned',
        `edits[${index}]: field "${edit.field}" on step "${edit.stepId}" currently holds author code`,
      )
    }
    return splice(source, existing.initializer.getStart(sf), existing.initializer.end, literal)
  }
  const idProp = getProperty(ts, step.obj, 'id')
  if (idProp === undefined) {
    return fail(
      'unsupported',
      `edits[${index}]: step "${edit.stepId}" has no id property to anchor an insertion`,
    )
  }
  return splice(source, idProp.end, idProp.end, `, ${edit.field}: ${literal}`)
}

// ─── addStep ────────────────────────────────────────────────────────────────

function applyAddStep(
  ts: TS,
  sf: tsNS.SourceFile,
  source: string,
  edit: Extract<GraphEdit, { kind: 'addStep' }>,
  index: number,
): string | Failure {
  const spec = validateSpec(edit.step, index)
  if ('ok' in spec) return spec
  const existingIds = new Set(collectStepCalls(ts, sf).map((c) => c.id))
  if (existingIds.has(spec.id)) {
    return fail('unsupported', `edits[${index}]: a step with id "${spec.id}" already exists`)
  }
  // Ensure the builder import first; when that changes the source, re-parse so
  // every position used below is computed against the spliced text.
  const ensured = ensureBuilderAvailable(ts, sf, source, spec.kind, index)
  if ('ok' in ensured) return ensured
  const src = ensured.source
  const sf2 =
    src === source ? sf : ts.createSourceFile('workflow.ts', src, ts.ScriptTarget.Latest, true)
  const workflows = collectWorkflowCalls(ts, sf2).filter((w) => w.stepsArray !== undefined)
  let arr: tsNS.ArrayLiteralExpression | undefined
  let anchor: tsNS.Expression | undefined
  let matches = 0
  if (edit.afterStepId !== undefined) {
    if (typeof edit.afterStepId !== 'string') {
      return fail('unsupported', `edits[${index}]: afterStepId must be a string`)
    }
    for (const w of workflows) {
      for (const el of (w.stepsArray as tsNS.ArrayLiteralExpression).elements) {
        if (asBuilderCall(ts, el, STEP_BUILDERS)?.id === edit.afterStepId) {
          arr = w.stepsArray
          anchor = el
          matches++
        }
      }
    }
    if (arr === undefined) {
      return fail(
        'not-found',
        `edits[${index}]: afterStepId "${edit.afterStepId}" is not a top-level step`,
      )
    }
    if (matches > 1) {
      return fail(
        'unsupported',
        `edits[${index}]: afterStepId "${edit.afterStepId}" is ambiguous in source`,
      )
    }
  } else {
    if (workflows.length !== 1) {
      return fail(
        'unsupported',
        `edits[${index}]: source declares ${workflows.length} workflows; addStep without afterStepId is ambiguous`,
      )
    }
    arr = (workflows[0] as WorkflowCall).stepsArray
  }
  const steps = arr as tsNS.ArrayLiteralExpression
  const text = specToBuilderText(spec)
  const layout = arrayLayout(ts, sf2, src, steps)
  const insertion = layout.multiline ? `,\n${layout.indent}${text}` : `, ${text}`
  if (anchor !== undefined) {
    return splice(src, anchor.end, anchor.end, insertion)
  }
  const last = steps.elements[steps.elements.length - 1]
  if (last === undefined) {
    return splice(src, steps.getStart(sf2) + 1, steps.end - 1, text)
  }
  return splice(src, last.end, last.end, insertion)
}

function validateSpec(
  raw: unknown,
  index: number,
): (DeclarativeStepSpec & { kind: string }) | Failure {
  if (typeof raw !== 'object' || raw === null) {
    return fail('unsupported', `edits[${index}]: step spec must be an object`)
  }
  const spec = raw as Record<string, unknown>
  const kind = spec.kind
  if (typeof kind !== 'string' || SPEC_FIELDS[kind] === undefined) {
    return fail(
      'unsupported',
      `edits[${index}]: step kind "${String(kind)}" is not declaratively expressible (allowed: ${Object.keys(SPEC_FIELDS).join(', ')})`,
    )
  }
  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    return fail('unsupported', `edits[${index}]: step spec requires a non-empty string id`)
  }
  const fields = SPEC_FIELDS[kind] as Readonly<Record<string, 'string' | 'number' | 'json'>>
  for (const key of Object.keys(spec)) {
    if (key === 'kind' || key === 'id') continue
    const fieldType = fields[key]
    if (fieldType === undefined) {
      return fail(
        'unsupported',
        `edits[${index}]: field "${key}" is not allowed on a declarative ${kind} step`,
      )
    }
    const value = spec[key]
    if (fieldType === 'string' && typeof value !== 'string') {
      return fail('unsupported', `edits[${index}]: field "${key}" must be a string`)
    }
    if (fieldType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return fail('unsupported', `edits[${index}]: field "${key}" must be a finite number`)
    }
    if (fieldType === 'json' && !isGraphEditValue(value)) {
      return fail(
        'unsupported',
        `edits[${index}]: field "${key}" must be a JSON-serializable literal`,
      )
    }
  }
  for (const required of SPEC_REQUIRED[kind] as readonly string[]) {
    if (spec[required] === undefined) {
      return fail('unsupported', `edits[${index}]: declarative ${kind} step requires "${required}"`)
    }
  }
  return spec as unknown as DeclarativeStepSpec & { kind: string }
}

function specToBuilderText(spec: DeclarativeStepSpec): string {
  const fields = SPEC_FIELDS[spec.kind] as Readonly<Record<string, unknown>>
  const parts = [`id: ${serializeLiteral(spec.id)}`]
  for (const key of Object.keys(fields)) {
    const value = (spec as unknown as Record<string, GraphEditValue | undefined>)[key]
    if (value !== undefined) parts.push(`${key}: ${serializeLiteral(value)}`)
  }
  return `${spec.kind}({ ${parts.join(', ')} })`
}

/**
 * Make sure the builder identifier the generated step uses resolves: either
 * it is already imported from skelm / @skelm/core (added to the named imports
 * when missing) or a top-level declaration with that name exists.
 */
function ensureBuilderAvailable(
  ts: TS,
  sf: tsNS.SourceFile,
  source: string,
  builder: string,
  index: number,
): { source: string } | Failure {
  let firstNamed: tsNS.NamedImports | undefined
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const spec = literalString(ts, stmt.moduleSpecifier)
    if (spec === undefined || !IMPORT_SPECIFIERS.has(spec)) continue
    const bindings = stmt.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const el of bindings.elements) {
      if (el.name.text === builder || el.propertyName?.text === builder) return { source }
    }
    firstNamed ??= bindings
  }
  if (firstNamed !== undefined) {
    const last = firstNamed.elements[firstNamed.elements.length - 1]
    if (last === undefined)
      return { source: splice(source, firstNamed.end - 1, firstNamed.end - 1, ` ${builder} `) }
    return { source: splice(source, last.end, last.end, `, ${builder}`) }
  }
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === builder) return { source }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === builder) return { source }
      }
    }
  }
  return fail(
    'unsupported',
    `edits[${index}]: cannot guarantee the "${builder}" builder is importable in this source`,
  )
}

// ─── removeStep ─────────────────────────────────────────────────────────────

function applyRemoveStep(
  ts: TS,
  sf: tsNS.SourceFile,
  source: string,
  edit: Extract<GraphEdit, { kind: 'removeStep' }>,
  index: number,
): string | Failure {
  if (typeof edit.stepId !== 'string') {
    return fail('unsupported', `edits[${index}]: removeStep requires stepId`)
  }
  let arr: tsNS.ArrayLiteralExpression | undefined
  let position = -1
  let matches = 0
  for (const w of collectWorkflowCalls(ts, sf)) {
    if (w.stepsArray === undefined) continue
    for (const [i, el] of w.stepsArray.elements.entries()) {
      if (asBuilderCall(ts, el, STEP_BUILDERS)?.id === edit.stepId) {
        arr = w.stepsArray
        position = i
        matches++
      }
    }
  }
  if (arr === undefined) {
    return fail(
      'not-found',
      `edits[${index}]: no top-level step with id "${edit.stepId}" was found`,
    )
  }
  if (matches > 1) {
    return fail('unsupported', `edits[${index}]: step id "${edit.stepId}" is ambiguous in source`)
  }
  const element = arr.elements[position] as tsNS.Expression
  const step = asBuilderCall(ts, element, STEP_BUILDERS) as BuilderCall
  if (isCodeOwnedStep(ts, step) || containsFunction(ts, element)) {
    return fail(
      'code-owned',
      `edits[${index}]: step "${edit.stepId}" carries author code; removing it requires a manual source edit`,
    )
  }
  if (interElementResidue(ts, sf, source, arr)) {
    return fail(
      'unsupported',
      `edits[${index}]: steps array carries comments that a removal cannot preserve`,
    )
  }
  if (position < arr.elements.length - 1) {
    const next = arr.elements[position + 1] as tsNS.Expression
    return splice(source, element.getStart(sf), next.getStart(sf), '')
  }
  if (position > 0) {
    const prev = arr.elements[position - 1] as tsNS.Expression
    return splice(source, prev.end, element.end, '')
  }
  return splice(source, arr.getStart(sf) + 1, arr.end - 1, '')
}

// ─── value serialization ────────────────────────────────────────────────────

function isGraphEditValue(value: unknown, depth = 0): value is GraphEditValue {
  if (depth > 32) return false
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object':
      if (Array.isArray(value)) return value.every((v) => isGraphEditValue(v, depth + 1))
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      ) {
        return false
      }
      return Object.values(value).every((v) => isGraphEditValue(v, depth + 1))
    default:
      return false
  }
}

function serializeLiteral(value: GraphEditValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return `'${escapeString(value)}'`
  if (Array.isArray(value)) return `[${value.map(serializeLiteral).join(', ')}]`
  const entries = Object.entries(value).map(([k, v]) => `${objectKey(k)}: ${serializeLiteral(v)}`)
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
}

function escapeString(value: string): string {
  let out = ''
  for (const ch of value) {
    const codePoint = ch.codePointAt(0) as number
    if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "\\'"
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (codePoint < 0x20 || codePoint === 0x2028 || codePoint === 0x2029) {
      out += `\\u${codePoint.toString(16).padStart(4, '0')}`
    } else out += ch
  }
  return out
}

function objectKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${escapeString(key)}'`
}

// ─── equivalence verification ───────────────────────────────────────────────

/**
 * Final gate before a result is returned `ok`: the emitted source must parse,
 * and every author function in the original must appear byte-identically (the
 * declarative edit surface can relocate but never rewrite or drop them).
 */
function verifyEquivalence(ts: TS, original: string, emitted: string): string | undefined {
  if (parseErrors(ts, emitted))
    return 'internal: emitted source does not parse; refusing to return it'
  const before = functionTextCounts(ts, original)
  const after = functionTextCounts(ts, emitted)
  for (const [text, count] of before) {
    if ((after.get(text) ?? 0) < count) {
      return 'internal: an author code region was not preserved byte-identically; refusing to return it'
    }
  }
  return undefined
}

function functionTextCounts(ts: TS, source: string): Map<string, number> {
  const sf = ts.createSourceFile('workflow.ts', source, ts.ScriptTarget.Latest, true)
  const counts = new Map<string, number>()
  walk(ts, sf, (node) => {
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      const text = node.getText(sf)
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
  })
  return counts
}

// ─── unified diff ───────────────────────────────────────────────────────────

const DIFF_CONTEXT = 3

/** Minimal unified diff (old → new) for human review; no external dependency. */
export function unifiedDiff(oldText: string, newText: string): string {
  if (oldText === newText) return ''
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const ops = diffOps(a, b)
  const hunks: string[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i]?.tag === 'equal') {
      i++
      continue
    }
    const start = i
    let end = i
    let gap = 0
    for (let j = i + 1; j < ops.length; j++) {
      if (ops[j]?.tag === 'equal') {
        gap++
        if (gap > DIFF_CONTEXT * 2) break
      } else {
        end = j
        gap = 0
      }
    }
    const from = Math.max(0, start - DIFF_CONTEXT)
    const to = Math.min(ops.length, end + 1 + DIFF_CONTEXT)
    const slice = ops.slice(from, to)
    const aStart = (slice[0] as DiffOp).aLine
    const bStart = (slice[0] as DiffOp).bLine
    const aCount = slice.filter((op) => op.tag !== 'insert').length
    const bCount = slice.filter((op) => op.tag !== 'delete').length
    const lines = slice.map((op) =>
      op.tag === 'equal' ? ` ${op.text}` : op.tag === 'delete' ? `-${op.text}` : `+${op.text}`,
    )
    hunks.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@\n${lines.join('\n')}`)
    i = to
  }
  return `--- a/workflow.ts\n+++ b/workflow.ts\n${hunks.join('\n')}\n`
}

interface DiffOp {
  tag: 'equal' | 'delete' | 'insert'
  text: string
  aLine: number
  bLine: number
}

function diffOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  const width = m + 1
  const lcs = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: 'equal', text: a[i] as string, aLine: i, bLine: j })
      i++
      j++
    } else if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)) {
      ops.push({ tag: 'delete', text: a[i] as string, aLine: i, bLine: j })
      i++
    } else {
      ops.push({ tag: 'insert', text: b[j] as string, aLine: i, bLine: j })
      j++
    }
  }
  while (i < n) {
    ops.push({ tag: 'delete', text: a[i] as string, aLine: i, bLine: j })
    i++
  }
  while (j < m) {
    ops.push({ tag: 'insert', text: b[j] as string, aLine: i, bLine: j })
    j++
  }
  return ops
}
