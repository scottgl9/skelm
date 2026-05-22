import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, type ExitCode } from './exit-codes.js'

export interface InitCommandArgs {
  dir: string
  template?: 'basic'
  force?: boolean
}

export interface InitCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export interface InitCommandResult {
  exitCode: ExitCode
}

/**
 * Scaffold a new skelm project at args.dir. Creates a package.json,
 * tsconfig.json, skelm.config.mts, an example workflow under workflows/,
 * and a .gitignore.
 *
 * Refuses to overwrite an existing project unless --force is passed.
 */
export async function initCommand(
  args: InitCommandArgs,
  io: InitCommandIO,
): Promise<InitCommandResult> {
  const dir = resolve(process.cwd(), args.dir)
  let mergeMode = false
  if (existsSync(dir) && !args.force) {
    const stat = await import('node:fs/promises').then((fs) => fs.stat(dir))
    if (stat.isDirectory() && (await isNonEmpty(dir))) {
      // Allow the common onboarding sequence:
      //   mkdir foo && cd foo && npm init -y && npm i skelm && skelm init .
      // by detecting the well-known npm-init residue (package.json,
      // node_modules/, package-lock.json) and merging the scaffold into the
      // existing tree. Anything beyond that demands --force so we don't
      // silently overwrite a real project.
      if (await isMergeableNpmInitDir(dir)) {
        mergeMode = true
      } else {
        io.stderr.write(`error: target directory is not empty: ${dir}\n`)
        io.stderr.write('hint: pass --force to scaffold over an existing tree\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
    }
  }

  const files = scaffoldFiles()
  for (const [relPath, contents] of files) {
    const fullPath = join(dir, relPath)
    // In merge mode, don't clobber an existing package.json — the user's
    // `npm init` filled in name/version; we add a `skelm` dep + start script
    // via mergePackageJson instead.
    if (mergeMode && relPath === 'package.json' && existsSync(fullPath)) {
      await mergePackageJson(fullPath, contents)
      continue
    }
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, contents, 'utf8')
  }

  io.stdout.write(`✓ scaffolded skelm project at ${dir}\n`)
  io.stdout.write('\nnext steps:\n')
  io.stdout.write(`  cd ${args.dir}\n`)
  io.stdout.write('  npm install\n')
  io.stdout.write('  skelm run workflows/hello.workflow.mts --input \'{"name":"world"}\'\n')
  return { exitCode: EXIT.OK }
}

async function isNonEmpty(dir: string): Promise<boolean> {
  const fs = await import('node:fs/promises')
  const entries = await fs.readdir(dir)
  return entries.length > 0
}

const NPM_INIT_RESIDUE = new Set([
  'package.json',
  'package-lock.json',
  'node_modules',
  '.gitignore',
  '.npmrc',
  'README.md',
])

// Files that mean "this is already a skelm project" — if any of these exist we
// must refuse merge so we don't overwrite the user's authored content.
const SKELM_PROJECT_MARKERS = new Set([
  'skelm.config.mts',
  'skelm.config.ts',
  'skelm.config.js',
  'skelm.config.mjs',
  'workflows',
])

/**
 * Decide whether `dir` is safe to merge a skelm scaffold into.
 *
 * Returns true when the directory either looks like fresh `npm init` /
 * `npm i` residue, OR holds incidental files (logs, hidden dotfiles,
 * editor turds) alongside the npm residue — anything that is NOT already
 * a skelm project. Returns false as soon as we see a skelm marker
 * (`skelm.config.*`, `workflows/`), so authored content is never
 * silently overwritten.
 */
async function isMergeableNpmInitDir(dir: string): Promise<boolean> {
  const fs = await import('node:fs/promises')
  const entries = await fs.readdir(dir)
  if (entries.length === 0) return true
  // Hard stop: any skelm-shaped artefact means "this is already a skelm
  // project" — demand --force.
  if (entries.some((e) => SKELM_PROJECT_MARKERS.has(e))) return false
  // We accept the merge when the directory has at least one npm residue
  // marker (so we're not silently scaffolding into a random folder), but
  // we tolerate extra files that are obviously incidental — bash history,
  // editor swap files, scratch logs, hidden dotfiles.
  const hasNpmResidue = entries.some((e) => NPM_INIT_RESIDUE.has(e))
  if (!hasNpmResidue) return false
  return entries.every((e) => NPM_INIT_RESIDUE.has(e) || isIncidentalFile(e))
}

function isIncidentalFile(name: string): boolean {
  // Hidden dotfiles other than the ones we already scaffold.
  if (name.startsWith('.') && !NPM_INIT_RESIDUE.has(name)) return true
  // Logs and editor swap/temp files.
  if (name.endsWith('.log')) return true
  if (name.endsWith('.swp') || name.endsWith('.swo')) return true
  if (name.endsWith('~')) return true
  return false
}

async function mergePackageJson(path: string, scaffold: string): Promise<void> {
  const fs = await import('node:fs/promises')
  const existing = JSON.parse(await fs.readFile(path, 'utf8'))
  const fresh = JSON.parse(scaffold)
  // The scaffold's config + workflow are ESM (.mts uses `import`). When an
  // existing package.json carries `"type": "commonjs"` (npm init's default
  // on some versions), preserving it would force Node's loader to parse
  // .mts/.ts as CJS and explode on the first `import` statement. The
  // scaffold's `"module"` always wins for that reason.
  const merged = {
    ...existing,
    type: fresh.type,
    scripts: { ...fresh.scripts, ...(existing.scripts ?? {}) },
    dependencies: { ...(existing.dependencies ?? {}), ...fresh.dependencies },
  }
  await fs.writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
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

function scaffoldFiles(): ReadonlyArray<readonly [string, string]> {
  const skelmVersion = getSkelmVersion()
  return [
    ['package.json', makePackageJson(skelmVersion)],
    ['tsconfig.json', TSCONFIG],
    ['skelm.config.mts', SKELM_CONFIG],
    ['workflows/hello.workflow.mts', HELLO_WORKFLOW],
    ['.gitignore', GITIGNORE],
    ['README.md', PROJECT_README],
  ]
}

function makePackageJson(skelmVersion: string): string {
  return `{
  "name": "skelm-project",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "skelm run workflows/hello.workflow.mts --input '{\\"name\\":\\"world\\"}'"
  },
  "dependencies": {
    "skelm": "^${skelmVersion}",
    "zod": "^4.4.2"
  }
}
`
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["workflows/**/*.mts", "workflows/**/*.ts", "skelm.config.mts"]
}
`

const SKELM_CONFIG = `import { defineConfig } from 'skelm'

export default defineConfig({
  // Default-deny is the framework's posture. Widen here only when needed.
  defaults: {
    permissions: {
      networkEgress: 'deny',
      allowedExecutables: [],
      allowedTools: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: [],
      fsWrite: [],
    },
  },
  pipelines: {
    discovery: 'auto',
    glob: 'workflows/**/*.workflow.{mts,ts}',
  },
  secrets: { driver: 'env' },
})
`

const HELLO_WORKFLOW = `import { code, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'hello',
  description: 'Greets someone by name.',
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ greeting: z.string() }),
  steps: [
    code({
      id: 'greet',
      run: (ctx) => ({ greeting: \`hello, \${(ctx.input as { name: string }).name}\` }),
    }),
  ],
})
`

const GITIGNORE = `node_modules/
dist/
.skelm/
.env
.env.*
!.env.example
*.log
`

const PROJECT_README = `# skelm-project

A skelm project scaffolded by \`skelm init\`.

## Layout

- \`skelm.config.mts\` — project config (ESM \`.mts\` keeps Node's native loader
  honest regardless of \`package.json\` \`"type"\`).
- \`workflows/\` — pipeline source files. \`.mts\` is canonical; \`.ts\` also works.

## Run

\`\`\`sh
npm install
skelm run workflows/hello.workflow.mts --input '{"name":"world"}'
\`\`\`

See [the skelm docs](https://github.com/scottgl9/skelm/tree/main/docs) for more.
`
