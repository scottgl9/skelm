import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { Runner, SqliteRunStore } from '@skelm/core'
import { type ServerConfig, createServer } from '@skelm/gateway'
import { EXIT, type ExitCode } from './exit-codes.js'
import type { MainIO, MainResult } from './main.js'

export interface ServeArgs {
  port?: number
  host?: string
  auth?: 'none' | 'bearer'
  token?: string
  configPath?: string
}

export async function serveCommand(args: ServeArgs, io: MainIO): Promise<MainResult> {
  const port = args.port ?? 3000
  const host = args.host ?? '127.0.0.1'
  const auth = args.auth ?? 'none'
  const token = args.token ?? process.env.SKELM_TOKEN

  // Validate security: reject insecure startup
  if (auth === 'none' && host !== '127.0.0.1' && host !== 'localhost') {
    io.stderr.write(
      `error: insecure startup rejected\n--host ${host} with --auth none is not allowed\nUse --auth bearer and set SKELM_TOKEN or --token <value>\n`,
    )
    return { exitCode: EXIT.CLI_ERROR }
  }

  // Load pipelines from config or default location
  const configPath = args.configPath ?? 'skelm.config.ts'
  let pipelines: unknown[] = []

  try {
    // TODO: Load pipelines from config file
    // For now, we'll use an empty list
    pipelines = []
  } catch (err) {
    io.stderr.write(
      `warning: could not load pipelines from ${configPath}: ${(err as Error).message}\n`,
    )
  }

  // Create run store
  const dbPath = resolve(process.cwd(), '.skelm', 'runs.sqlite')
  await fs.mkdir(resolve(process.cwd(), '.skelm'), { recursive: true })
  const runStore = new SqliteRunStore({ path: dbPath })

  // Create runner
  const runner = new Runner({
    store: runStore,
  })

  // Create server config
  const serverConfig: ServerConfig = {
    port,
    host,
    auth,
    ...(token !== undefined && { token }),
    maxConcurrentRuns: 10,
  }

  // Create and start server
  // TODO: Load actual pipelines
  const server = createServer(serverConfig, {
    pipelines: pipelines as never,
    runStore,
    runner,
  })

  io.stdout.write(`Starting skelm server...\n  URL: http://${host}:${port}\n  Auth: ${auth}\n`)
  if (auth === 'bearer') {
    io.stdout.write(`  Token: ${token ? 'configured' : 'from SKELM_TOKEN env var'}\n`)
  }
  io.stdout.write('\n')

  try {
    await server.start()
    io.stdout.write(`Server started at ${server.getUrl()}\n`)
    io.stdout.write('Press Ctrl+C to stop\n')

    // Keep process alive
    await new Promise(() => {}) // Never resolves
  } catch (err) {
    io.stderr.write(`error: server failed to start: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  // Unreachable, but TypeScript needs this
  return { exitCode: EXIT.OK }
}
