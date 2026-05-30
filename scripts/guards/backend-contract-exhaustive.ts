#!/usr/bin/env tsx
// Guard: every first-party backend package must run the shared
// backend-contract suite (`runBackendContract` from
// `@skelm/core/testing/contract`). Without this, backends silently drift
// from the SkelmBackend SPI — drift that historically caused the
// per-backend agentmemory / permission gaps now being paid down.
//
// Mechanic: each backend listed below must contain a file at
// `packages/<pkg>/test/contract.test.ts` that imports
// `runBackendContract`. We do not parse what suites are skipped; the
// always-on capability-self-consistency block runs even with every
// optional suite skipped, and that is the minimum bar this guard
// enforces. Per-backend tests should grow inference/agent/permission-gate
// coverage over time.
//
// Adding a new backend? Add its package name to BACKENDS below and ship
// a contract.test.ts alongside it. Removing a package is the only path
// out of this list.
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

const BACKENDS = ['agent', 'codex', 'opencode', 'pi', 'vercel-ai'] as const

const REQUIRED_IMPORT = 'runBackendContract'

async function check(pkg: string): Promise<string | undefined> {
  const path = join(REPO_ROOT, 'packages', pkg, 'test', 'contract.test.ts')
  let src: string
  try {
    src = await readFile(path, 'utf8')
  } catch {
    return `missing ${path} — every backend must run runBackendContract from @skelm/core/testing/contract`
  }
  if (!src.includes(REQUIRED_IMPORT)) {
    return `${path} exists but does not import ${REQUIRED_IMPORT} from @skelm/core/testing/contract`
  }
  return undefined
}

async function main(): Promise<void> {
  const failures: string[] = []
  for (const pkg of BACKENDS) {
    const failure = await check(pkg)
    if (failure !== undefined) failures.push(failure)
  }
  if (failures.length > 0) {
    console.error('backend-contract-exhaustive: failures:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('backend-contract-exhaustive: unexpected error', err)
  process.exit(1)
})
