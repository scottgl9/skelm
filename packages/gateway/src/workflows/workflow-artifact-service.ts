import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { WorkflowRegistrationError } from './workflow-registration-service.js'

// Hard excludes — never copied regardless of .gitignore. `.git`/`.skelm`/
// `node_modules` are structural (node_modules is re-symlinked separately); the
// rest are caches/runtime output that are never an import target but routinely
// dwarf a project and trip the size cap. The .gitignore-aware skip below is the
// primary mechanism; this denylist is the safety net for projects that ship
// such dirs without a matching ignore entry. NOTE: `dist`/`build`/`out` are
// deliberately NOT here — a managed workflow may import its own compiled output
// (see the "keeps dist artifacts" registration test), so those are skipped only
// when the project's own .gitignore ignores them.
const EXCLUDED_DIRS = new Set([
  '.git',
  '.skelm',
  'node_modules',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.codegraph',
  'logs',
])

export interface WorkflowArtifactOptions {
  artifactRoot: string
  maxBytes: number
}

export interface MaterializeTreeInput {
  id: string
  sourceRoot: string
  entryPath: string
  originPath?: string
  configPath?: string
}

export interface MaterializedWorkflowArtifact {
  artifactDir: string
  entryPath: string
  originPath?: string
  configPath?: string
}

/**
 * Copies trusted workflow source trees into gateway-owned storage. The managed
 * copy is what later runs import and what future source-edit routes may mutate.
 */
export class WorkflowArtifactService {
  constructor(private readonly options: WorkflowArtifactOptions) {}

  get artifactRoot(): string {
    return this.options.artifactRoot
  }

  async materializeTree(input: MaterializeTreeInput): Promise<MaterializedWorkflowArtifact> {
    const sourceRoot = await realpath(input.sourceRoot)
    const entryPath = await realpath(input.entryPath)
    assertWithin(entryPath, sourceRoot, 'entry path')
    const configPath =
      input.configPath !== undefined && input.configPath.length > 0
        ? await realpath(input.configPath)
        : undefined
    if (configPath !== undefined) assertWithin(configPath, sourceRoot, 'config path')

    const parentDir = this.parentFor(input.id)
    const artifactDir = this.destinationFor(input.id)
    const staging = `${artifactDir}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const bytes = { total: 0 }
    const ignore = await loadGitignore(sourceRoot)
    try {
      await mkdir(parentDir, { recursive: true })
      await copyTree(
        sourceRoot,
        staging,
        this.options.maxBytes,
        bytes,
        sourceRoot,
        new Set(),
        ignore,
      )
      await symlinkNearestNodeModules(sourceRoot, staging)
      await rename(staging, artifactDir)
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw err
    }

    const entryRel = relative(sourceRoot, entryPath)
    const configRel = configPath === undefined ? undefined : relative(sourceRoot, configPath)
    return {
      artifactDir,
      entryPath: join(artifactDir, entryRel),
      ...(input.originPath !== undefined && { originPath: input.originPath }),
      ...(configRel !== undefined && { configPath: join(artifactDir, configRel) }),
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.parentFor(id), { recursive: true, force: true })
  }

  destinationFor(id: string): string {
    return join(this.parentFor(id), revisionSegment())
  }

  private parentFor(id: string): string {
    return join(this.options.artifactRoot, encodeURIComponent(id))
  }
}

async function copyTree(
  source: string,
  dest: string,
  maxBytes: number,
  bytes: { total: number },
  sourceRoot: string,
  visited: Set<string>,
  ignore: GitignoreMatcher,
  inheritedIgnored = false,
): Promise<void> {
  const stat = await lstat(source)
  if (stat.isSymbolicLink()) {
    // A symlink is only safe if its target resolves inside the source root —
    // otherwise it could smuggle external content into the gateway-owned
    // artifact (path escape). We dereference an in-root target and copy its
    // real content; an out-of-root or unresolvable target stays rejected.
    let target: string
    try {
      target = await realpath(source)
    } catch {
      throw new WorkflowRegistrationError(
        400,
        `workflow source contains unresolvable symbolic link: ${source}`,
      )
    }
    assertWithin(target, sourceRoot, `symbolic link target (${source})`)
    if (visited.has(target)) return
    await copyTree(
      target,
      dest,
      maxBytes,
      bytes,
      sourceRoot,
      new Set(visited).add(target),
      ignore,
      inheritedIgnored,
    )
    return
  }
  if (stat.isDirectory()) {
    await mkdir(dest, { recursive: true })
    for (const name of await readdir(source)) {
      if (EXCLUDED_DIRS.has(name)) continue
      const child = join(source, name)
      const childRel = relative(sourceRoot, child)
      // Pass the child's REAL type: a directory-only rule (`config/`) must not
      // match a plain file named `config`. A symlink counts as a non-directory
      // (git treats it as a file for ignore purposes).
      const childIsDir = (await lstat(child)).isDirectory()
      const childIgnored = ignore.ignores(childRel, childIsDir, inheritedIgnored)
      if (childIgnored) {
        // Prune the ignored node UNLESS it is a directory a later negation rule
        // could re-include a descendant of — then descend with the ignore status
        // inherited, so the per-node checks re-include only the negated paths
        // (e.g. `dist/` + `!dist/keep.js` keeps keep.js, drops the rest).
        if (!childIsDir || !ignore.mayReincludeUnder(childRel)) continue
      }
      await copyTree(
        child,
        join(dest, name),
        maxBytes,
        bytes,
        sourceRoot,
        visited,
        ignore,
        childIgnored,
      )
    }
    return
  }
  if (ignore.ignores(relative(sourceRoot, source), false, inheritedIgnored)) return
  if (!stat.isFile()) return
  bytes.total += stat.size
  if (bytes.total > maxBytes) {
    throw new WorkflowRegistrationError(
      413,
      `workflow source tree exceeds maximum size of ${maxBytes} bytes`,
    )
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, await readFile(source))
}

/**
 * Ensure a generated/extracted workflow dir can resolve framework imports
 * (`skelm`/`@skelm/*`). Used by paths that write a workflow module into the
 * state dir without a dependency tree of their own — inline-JSON register and
 * archive upload both land a module importing `skelm` under
 * `uploaded-workflows/<id>/`, which has no node_modules to resolve against, so
 * the managed load fails with "Cannot find package 'skelm'". Skips when the dir
 * already resolves a node_modules (its own or an ancestor's), so a bundled tree
 * is never shadowed.
 */
export async function linkRuntimeNodeModules(dir: string): Promise<void> {
  if ((await findNearestNodeModules(dir)) !== undefined) return
  const runtime = await findRuntimeNodeModules()
  if (runtime === undefined) return
  await symlink(runtime, join(dir, 'node_modules'))
}

async function symlinkNearestNodeModules(sourceRoot: string, artifactDir: string): Promise<void> {
  // Prefer the workflow's own dependency tree. When the source lives outside any
  // project (e.g. `skelm run /tmp/standalone.ts`), the materialized copy under
  // managed-workflows has no node_modules to resolve framework imports against;
  // fall back to the gateway's own node_modules so `skelm`/`@skelm/*` still load.
  const sourceNodeModules =
    (await findNearestNodeModules(sourceRoot)) ?? (await findRuntimeNodeModules())
  if (sourceNodeModules === undefined) return
  await symlink(sourceNodeModules, join(artifactDir, 'node_modules'))
}

let runtimeNodeModules: string | null | undefined
async function findRuntimeNodeModules(): Promise<string | undefined> {
  if (runtimeNodeModules !== undefined) return runtimeNodeModules ?? undefined
  // In a real install `skelm` resolves under a node_modules whose siblings include
  // `@skelm/*`. In a workspace checkout it resolves to source (no node_modules
  // ancestor), so fall back to the node_modules nearest the gateway's cwd.
  let resolved: string | undefined
  try {
    const start = dirname(createRequire(import.meta.url).resolve('skelm/package.json'))
    resolved = await nearestNamedNodeModules(start)
  } catch {
    resolved = undefined
  }
  resolved ??= await findNearestNodeModules(process.cwd())
  runtimeNodeModules = resolved ?? null
  return resolved
}

async function nearestNamedNodeModules(start: string): Promise<string | undefined> {
  let dir = start
  for (;;) {
    if (dir.endsWith(`${sep}node_modules`)) return await realpath(dir)
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

async function findNearestNodeModules(sourceRoot: string): Promise<string | undefined> {
  let dir = sourceRoot
  for (;;) {
    const candidate = join(dir, 'node_modules')
    try {
      const stat = await lstat(candidate)
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        return await realpath(candidate)
      }
    } catch {
      // keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

interface GitignoreMatcher {
  /**
   * Whether `relPath` is ignored. `inherited` carries the ignore status of the
   * parent directory: a node under an ignored directory is ignored unless a
   * later rule (a negation) re-includes it — this is how `dist/` + `!dist/keep.js`
   * keeps `keep.js` while dropping the rest of `dist/`.
   */
  ignores(relPath: string, isDir: boolean, inherited: boolean): boolean
  /**
   * Whether a negation rule could re-include some descendant of the ignored
   * directory `relPath`. When true the walker must DESCEND into the ignored
   * directory (rather than pruning it) so the re-included descendant is reached.
   */
  mayReincludeUnder(relPath: string): boolean
}

interface GitignoreRule {
  re: RegExp
  negated: boolean
  dirOnly: boolean
  /** Cleaned pattern (root-relative path, or a bare basename). */
  body: string
  /** True when `body` contains a path separator (anchored to the root). */
  hasSlash: boolean
  /** True when `body` contains a glob metacharacter (`*`, `?`, `[`). */
  glob: boolean
}

const ALLOW_NOTHING: GitignoreMatcher = {
  ignores: () => false,
  mayReincludeUnder: () => false,
}

/**
 * Builds a matcher from the source root's `.gitignore` so build/runtime output
 * a project already ignores is skipped during materialization instead of being
 * copied (and tripping the size cap). Scope is deliberately the root file only
 * — the common case behind the 413 — backed by the hard {@link EXCLUDED_DIRS}
 * denylist for projects that ship such dirs without an ignore entry. Unparsable
 * or absent `.gitignore` means copy everything (minus the hard excludes).
 */
async function loadGitignore(sourceRoot: string): Promise<GitignoreMatcher> {
  let text: string
  try {
    text = await readFile(join(sourceRoot, '.gitignore'), 'utf8')
  } catch {
    return ALLOW_NOTHING
  }
  const rules: GitignoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    const rule = parseGitignoreLine(raw)
    if (rule !== undefined) rules.push(rule)
  }
  if (rules.length === 0) return ALLOW_NOTHING
  const hasNegation = rules.some((r) => r.negated)
  return {
    ignores(relPath, isDir, inherited) {
      const normalized = relPath.split(sep).join('/')
      let ignored = inherited
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue
        if (rule.re.test(normalized)) ignored = !rule.negated
      }
      return ignored
    },
    mayReincludeUnder(relPath) {
      if (!hasNegation) return false
      const dir = relPath.split(sep).join('/')
      for (const rule of rules) {
        if (!rule.negated) continue
        // A bare basename matches at any depth, so it could re-include a file
        // anywhere under `dir`. An anchored glob might too — be conservative.
        if (!rule.hasSlash || rule.glob) return true
        // A literal, root-anchored negation only matters when it targets a path
        // inside `dir`.
        if (rule.body === dir || rule.body.startsWith(`${dir}/`)) return true
      }
      return false
    },
  }
}

function parseGitignoreLine(raw: string): GitignoreRule | undefined {
  let line = raw.replace(/\s+$/, '')
  if (line.length === 0 || line.startsWith('#')) return undefined
  let negated = false
  if (line.startsWith('!')) {
    negated = true
    line = line.slice(1)
  }
  // Trailing slash means directory-only; a leading slash anchors to the root.
  let dirOnly = false
  if (line.endsWith('/')) {
    dirOnly = true
    line = line.slice(0, -1)
  }
  const anchored = line.startsWith('/')
  if (anchored) line = line.slice(1)
  if (line.length === 0) return undefined
  // `line` is now the root-relative body. A body with a slash is path-anchored;
  // a slash-free body matches its basename at any depth.
  return {
    re: gitignorePatternToRegExp(line, anchored),
    negated,
    dirOnly,
    body: line,
    hasSlash: line.includes('/'),
    glob: /[*?[]/.test(line),
  }
}

function gitignorePatternToRegExp(pattern: string, anchored: boolean): RegExp {
  // A pattern with no internal slash matches at any depth; otherwise it is
  // relative to the (anchored) root. Both also match everything beneath a
  // matched directory.
  const matchesAnyDepth = !anchored && !pattern.includes('/')
  let body = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        body += '[^/]*'
      }
    } else if (ch === '?') {
      body += '[^/]'
    } else {
      body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  const prefix = matchesAnyDepth ? '(?:^|.*/)' : '^'
  return new RegExp(`${prefix}${body}(?:/.*)?$`)
}

function assertWithin(target: string, root: string, label: string): void {
  const normRoot = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(normRoot)) {
    throw new WorkflowRegistrationError(400, `${label} is outside the workflow source root`)
  }
}

function revisionSegment(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
