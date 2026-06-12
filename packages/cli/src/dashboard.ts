import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EXIT, type ExitCode } from './exit-codes.js'
import type { MainIO } from './internal/io.js'

export interface DashboardCommandArgs {
  subcommand: 'init' | 'start'
  dir?: string
  host?: string
  port?: number
  gatewayUrl?: string
  token?: string
  force?: boolean
}

export interface DashboardCommandResult {
  exitCode: ExitCode
}

const DASHBOARD_MARKERS = [
  'dashboard.config.mts',
  'src/server.mts',
  'src/public/index.html',
] as const

const TEMPLATE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['dashboard.config.mts.tmpl', 'dashboard.config.mts'],
  ['src/server.mts.tmpl', 'src/server.mts'],
  ['README.md.tmpl', 'README.md'],
  ['gitignore.tmpl', '.gitignore'],
  ['src/public/index.html.tmpl', 'src/public/index.html'],
  ['src/public/app.mts.tmpl', 'src/public/app.mts'],
  ['src/public/styles.css.tmpl', 'src/public/styles.css'],
  ['src/public/logo-icon.svg.tmpl', 'src/public/logo-icon.svg'],
]

export async function dashboardCommand(
  args: DashboardCommandArgs,
  io: MainIO,
): Promise<DashboardCommandResult> {
  const relDir = args.dir ?? (isDashboardProject(process.cwd()) ? '.' : 'dashboard')
  const dir = resolve(process.cwd(), relDir)
  if (args.subcommand === 'init') return initDashboard(dir, relDir, args.force === true, io)
  return startDashboard(dir, relDir, args, io)
}

async function initDashboard(
  dir: string,
  relDir: string,
  force: boolean,
  io: MainIO,
): Promise<DashboardCommandResult> {
  const alreadyScaffolded = isDashboardProject(dir)
  if (!alreadyScaffolded && !force && existsSync(dir) && (await isNonEmpty(dir))) {
    io.stderr.write(`error: target directory is not empty: ${dir}\n`)
    io.stderr.write('hint: pass --force to scaffold the dashboard over an existing tree\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  await scaffold(dir)
  io.stdout.write(
    alreadyScaffolded
      ? `✓ re-scaffolded skelm dashboard at ${dir}\n`
      : `✓ scaffolded skelm dashboard at ${dir}\n`,
  )
  io.stdout.write('\nnext steps:\n')
  if (relDir !== '.') io.stdout.write(`  cd ${relDir}\n`)
  io.stdout.write('  skelm dashboard start\n')
  return { exitCode: EXIT.OK }
}

async function startDashboard(
  dir: string,
  relDir: string,
  args: DashboardCommandArgs,
  io: MainIO,
): Promise<DashboardCommandResult> {
  if (!isDashboardProject(dir)) {
    io.stderr.write(`error: dashboard project not found at ${dir}\n`)
    io.stderr.write(`hint: run skelm dashboard init ${relDir === '.' ? '' : relDir}`.trimEnd())
    io.stderr.write('\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  const serverUrl = pathToFileURL(join(dir, 'src', 'server.mts')).href
  const mod = (await import(serverUrl)) as {
    startDashboardServer?: (opts: {
      host?: string
      port?: number
      gatewayUrl?: string
      token?: string
    }) => Promise<{ url: string; close: () => Promise<void> | void }>
  }
  if (typeof mod.startDashboardServer !== 'function') {
    io.stderr.write('error: dashboard src/server.mts does not export startDashboardServer()\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  const server = await mod.startDashboardServer({
    ...(args.host !== undefined && { host: args.host }),
    ...(args.port !== undefined && { port: args.port }),
    ...(args.gatewayUrl !== undefined && { gatewayUrl: args.gatewayUrl }),
    ...(args.token !== undefined && { token: args.token }),
  })
  io.stdout.write(`skelm dashboard listening at ${server.url}\n`)
  if (process.env.SKELM_DASHBOARD_TEST_ONCE === '1') {
    await server.close()
    return { exitCode: EXIT.OK }
  }
  await waitForShutdown()
  await server.close()
  return { exitCode: EXIT.OK }
}

async function scaffold(dir: string): Promise<void> {
  const templateDir = join(assetsDir(), 'dashboard-template')
  await writeFileEnsured(join(dir, 'package.json'), makeDashboardPackageJson(getSkelmVersion()))
  for (const [src, dest] of TEMPLATE_FILES) {
    const contents = readFileSync(join(templateDir, src), 'utf8')
    await writeFileEnsured(join(dir, dest), contents)
  }
}

async function writeFileEnsured(fullPath: string, contents: string): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, contents, 'utf8')
}

async function isNonEmpty(dir: string): Promise<boolean> {
  return (await readdir(dir)).length > 0
}

function isDashboardProject(dir: string): boolean {
  return DASHBOARD_MARKERS.every((m) => existsSync(join(dir, m)))
}

function assetsDir(): string {
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

function makeDashboardPackageJson(_version: string): string {
  return `{
  "name": "skelm-dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "skelm dashboard start"
  }
}
`
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      resolve()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
}
