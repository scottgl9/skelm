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
 * tsconfig.json, skelm.config.ts, an example workflow under workflows/,
 * and a .gitignore.
 *
 * Refuses to overwrite an existing project unless --force is passed.
 */
export async function initCommand(
  args: InitCommandArgs,
  io: InitCommandIO,
): Promise<InitCommandResult> {
  const dir = resolve(process.cwd(), args.dir)
  if (existsSync(dir) && !args.force) {
    const stat = await import('node:fs/promises').then((fs) => fs.stat(dir))
    if (stat.isDirectory() && (await isNonEmpty(dir))) {
      io.stderr.write(`error: target directory is not empty: ${dir}\n`)
      io.stderr.write('hint: pass --force to scaffold over an existing tree\n')
      return { exitCode: EXIT.CLI_ERROR }
    }
  }

  const files = scaffoldFiles()
  for (const [relPath, contents] of files) {
    const fullPath = join(dir, relPath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, contents, 'utf8')
  }

  io.stdout.write(`✓ scaffolded skelm project at ${dir}\n`)
  io.stdout.write('\nnext steps:\n')
  io.stdout.write(`  cd ${args.dir}\n`)
  io.stdout.write('  npm install\n')
  io.stdout.write('  skelm run workflows/hello.workflow.ts --input \'{"name":"world"}\'\n')
  return { exitCode: EXIT.OK }
}

async function isNonEmpty(dir: string): Promise<boolean> {
  const fs = await import('node:fs/promises')
  const entries = await fs.readdir(dir)
  return entries.length > 0
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
    ['skelm.config.ts', SKELM_CONFIG],
    ['workflows/hello.workflow.ts', HELLO_WORKFLOW],
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
    "start": "skelm run workflows/hello.workflow.ts --input '{\\"name\\":\\"world\\"}'"
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
  "include": ["workflows/**/*.ts", "skelm.config.ts"]
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
    glob: 'workflows/**/*.workflow.ts',
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

## Run

\`\`\`sh
npm install
skelm run workflows/hello.workflow.ts --input '{"name":"world"}'
\`\`\`

See [the skelm docs](https://github.com/scottgl9/skelm/tree/main/docs) for more.
`
