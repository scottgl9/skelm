// Package self-test: runs representative workflows against deterministic fakes
// (no real agentmemory backend, no run store) and exits non-zero on failure.
// Reuses the shipped testing fakes so the same enforcement path is exercised.

import { resolveMemorySystemConfig } from './config.js'
import { makeFakeMemory, makeFakeState } from './testing.js'
import type { MemorySystemDeps } from './types.js'
import { runDailyNote } from './workflows/daily-note.js'
import { runStalePrune } from './workflows/stale-prune.js'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`memory-system self-test: ${msg}`)
}

export async function runSelfTest(): Promise<void> {
  const config = resolveMemorySystemConfig({ project: 'self-test' })

  // 1. daily-note: recalls + saves one rollup.
  const dailyMem = makeFakeMemory('daily-note', {
    recall: [
      { id: 'a', title: 'Auth', content: 'We sign JWTs with HS256.' },
      { id: 'b', title: 'DB', content: 'Postgres 16 in prod.' },
    ],
  })
  const dailyDeps: MemorySystemDeps = {
    memory: dailyMem,
    state: makeFakeState(),
    project: config.project,
  }
  const daily = await runDailyNote(dailyDeps, config)
  assert(daily.ok, 'daily-note should succeed')
  assert(dailyMem.saved.length === 1, 'daily-note should save exactly one rollup')
  assert(daily.stats.recalled === 2, 'daily-note should recall two memories')

  // 2. stale-prune: read-only ceiling — recall allowed, save must be denied.
  const pruneMem = makeFakeMemory('stale-prune', {
    recall: [{ id: 'old', title: 'X', content: 'y' }],
  })
  const pruneDeps: MemorySystemDeps = {
    memory: pruneMem,
    state: makeFakeState(),
    project: config.project,
  }
  await runStalePrune(pruneDeps, config)
  // A defensive save proves the gate: even if asked, no write reaches the fake.
  await pruneMem.save({ title: 't', content: 'c' })
  assert(pruneMem.saved.length === 0, 'stale-prune must not be able to save (default-deny)')

  process.stdout.write('memory-system self-test: ok\n')
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  runSelfTest().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
