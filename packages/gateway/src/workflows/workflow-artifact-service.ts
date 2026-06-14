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
    await copyTree(target, dest, maxBytes, bytes, sourceRoot, new Set(visited).add(target), ignore)
    return
  }
  if (stat.isDirectory()) {
    await mkdir(dest, { recursive: true })
    for (const name of await readdir(source)) {
      if (EXCLUDED_DIRS.has(name)) continue
      const child = join(source, name)
      // Pass the child's REAL type: a directory-only rule (`config/`) must not
      // match a plain file named `config`. A symlink counts as a non-directory
      // (git treats it as a file for ignore purposes).
      const childIsDir = (await lstat(child)).isDirectory()
      if (ignore.ignores(relative(sourceRoot, child), childIsDir)) continue
      await copyTree(child, join(dest, name), maxBytes, bytes, sourceRoot, visited, ignore)
    }
    return
  }
  if (ignore.ignores(relative(sourceRoot, source), false)) return
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

async function symlinkNearestNodeModules(sourceRoot: string, artifactDir: string): Promise<void> {
  const sourceNodeModules = await findNearestNodeModules(sourceRoot)
  if (sourceNodeModules === undefined) return
  await symlink(sourceNodeModules, join(artifactDir, 'node_modules'))
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
  ignores(relPath: string, isDir: boolean): boolean
}

interface GitignoreRule {
  re: RegExp
  negated: boolean
  dirOnly: boolean
}

const ALLOW_NOTHING: GitignoreMatcher = { ignores: () => false }

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
  return {
    ignores(relPath, isDir) {
      const normalized = relPath.split(sep).join('/')
      let ignored = false
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue
        if (rule.re.test(normalized)) ignored = !rule.negated
      }
      return ignored
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
  return { re: gitignorePatternToRegExp(line, anchored), negated, dirOnly }
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
