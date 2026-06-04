import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, type ExitCode } from './exit-codes.js'
import type { MainIO } from './internal/io.js'
import { runCommand } from './run.js'

export interface BuilderCommandArgs {
  /** Target directory for the builder project. Defaults to `builder`. */
  dir?: string
  force?: boolean
}

export interface BuilderCommandResult {
  exitCode: ExitCode
}

// Presence of BOTH markers means "already a builder project" — skip scaffolding
// and go straight to launch, so `skelm builder` is idempotent and re-runnable.
const BUILDER_MARKERS = ['builder.workflow.mts', 'skelm.config.mts'] as const

// Static template files copied verbatim into the target. `.tmpl` keeps them out
// of the repo's TS toolchain; the suffix (and the gitignore rename) is stripped
// on copy. package.json is generated separately to inject the skelm version.
const TEMPLATE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['tsconfig.json.tmpl', 'tsconfig.json'],
  ['skelm.config.mts.tmpl', 'skelm.config.mts'],
  ['builder.workflow.mts.tmpl', 'builder.workflow.mts'],
  ['chatui-frontend.mts.tmpl', 'chatui-frontend.mts'],
  ['README.md.tmpl', 'README.md'],
  ['gitignore.tmpl', '.gitignore'],
]

/**
 * `skelm builder [dir]`: scaffold a conversational workflow-builder project (a
 * persistent chat workflow + terminal chat UI wired to an agent backend) into
 * `dir` (default `./builder`), then drop the user into that chat UI.
 *
 * Idempotent: if the project already exists it skips scaffolding. Like
 * `skelm init`, it never auto-installs — if dependencies aren't present yet it
 * prints the install step and exits. Once deps are installed it delegates to
 * the same run path `skelm run <tui-dir>` uses, which activates the project on
 * the gateway and hosts the Ink frontend in this process.
 */
export async function builderCommand(
  args: BuilderCommandArgs,
  io: MainIO,
): Promise<BuilderCommandResult> {
  const relDir = args.dir ?? (isBuilderProject(process.cwd()) ? '.' : 'builder')
  const dir = resolve(process.cwd(), relDir)
  const alreadyScaffolded = BUILDER_MARKERS.every((m) => existsSync(join(dir, m)))

  // Scaffold a fresh project, or re-scaffold an existing one when --force is
  // passed (refreshes templates + the bundled skill, e.g. after a skelm
  // upgrade). Without --force an existing builder project is left untouched and
  // we fall through to launch — idempotent.
  if (!alreadyScaffolded || args.force === true) {
    if (!alreadyScaffolded && !args.force && existsSync(dir) && (await isNonEmpty(dir))) {
      io.stderr.write(`error: target directory is not empty: ${dir}\n`)
      io.stderr.write('hint: pass --force to scaffold the builder over an existing tree\n')
      return { exitCode: EXIT.CLI_ERROR }
    }
    await scaffold(dir)
    io.stdout.write(
      alreadyScaffolded
        ? `✓ re-scaffolded skelm builder at ${dir} (--force)\n`
        : `✓ scaffolded skelm builder at ${dir}\n`,
    )
  }

  // The gateway loads skelm.config.mts, which imports @skelm/codex, @skelm/pi,
  // @skelm/integrations, ink, and react — so deps must be installed before we
  // can launch. We don't auto-install (mirrors `skelm init`).
  if (!existsSync(join(dir, 'node_modules'))) {
    io.stdout.write('\nnext steps:\n')
    if (relDir !== '.') io.stdout.write(`  cd ${relDir}\n`)
    io.stdout.write('  npm install\n')
    io.stdout.write('  skelm builder        # drops you into the builder chat UI\n')
    return { exitCode: EXIT.OK }
  }

  io.stdout.write(`\nstarting skelm builder in ${dir} …\n`)
  return runCommand({ workflowPath: dir }, io)
}

async function scaffold(dir: string): Promise<void> {
  const assets = assetsDir()
  const templateDir = join(assets, 'builder-template')

  await writeFileEnsured(join(dir, 'package.json'), makeBuilderPackageJson(getSkelmVersion()))

  for (const [src, dest] of TEMPLATE_FILES) {
    const contents = readFileSync(join(templateDir, src), 'utf8')
    await writeFileEnsured(join(dir, dest), contents)
  }

  // The agent loads the `skelm` skill (allowedSkills: ['skelm']); the gateway
  // discovers it from skills/**/SKILL.md relative to the project.
  const skill = readFileSync(join(assets, 'skelm-skill', 'SKILL.md'), 'utf8')
  await writeFileEnsured(join(dir, 'skills', 'skelm', 'SKILL.md'), skill)
}

async function writeFileEnsured(fullPath: string, contents: string): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, contents, 'utf8')
}

async function isNonEmpty(dir: string): Promise<boolean> {
  return (await readdir(dir)).length > 0
}

function isBuilderProject(dir: string): boolean {
  return BUILDER_MARKERS.every((m) => existsSync(join(dir, m)))
}

function assetsDir(): string {
  // Sibling of both src/ (vitest) and dist/ (published) under the cli package.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
}

function getSkelmVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function makeBuilderPackageJson(version: string): string {
  return `{
  "name": "skelm-builder",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "skelm builder"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": ">=0.75.0",
    "@skelm/codex": "^${version}",
    "@skelm/integrations": "^${version}",
    "@skelm/pi": "^${version}",
    "ink": "^6.0.0",
    "ink-text-input": "^6.0.0",
    "react": "^19.0.0",
    "skelm": "^${version}",
    "zod": "^4.4.2"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "typescript": "^5.6.3"
  }
}
`
}
