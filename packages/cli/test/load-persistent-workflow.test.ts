import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { isPersistentWorkflow } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { loadWorkflowFromFile } from '../src/load-workflow.js'
import { main } from '../src/main.js'

// Regression: a MINIMAL persistent workflow (no preamble `steps`) is not
// pipeline-shaped, so the loader used to reject it with "does not export a
// pipeline". That made every minimal persistent-workflow queue trigger
// undispatchable on the gateway — the fire threw before any run started, and a
// CLI-hosted (tui/web) submit then timed out with "turn did not start".
const FIXTURE = join(import.meta.dirname, 'fixtures', 'persistent', 'minimal.workflow.mts')

describe('loadWorkflowFromFile — persistent workflows', () => {
  it('loads a minimal persistent workflow (no steps) and preserves the brand', async () => {
    const wf = await loadWorkflowFromFile(FIXTURE)
    expect(isPersistentWorkflow(wf)).toBe(true)
    expect(wf.id).toBe('fixture-persistent')
    // The `kind` brand survives the spread the loader applies to attach baseDir.
    expect((wf as { kind?: string }).kind).toBe('persistent-workflow')
    expect((wf as { baseDir?: string }).baseDir).toContain('persistent')
  })

  it('`skelm validate` accepts a minimal persistent workflow (no false "empty" error)', async () => {
    const r = await invoke(['validate', FIXTURE])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).toMatch(/ok:/)
  })
})

async function invoke(argv: readonly string[]) {
  const out: string[] = []
  const err: string[] = []
  const stdout = new Writable({
    write(c, _e, cb) {
      out.push(c.toString())
      cb()
    },
  })
  const stderr = new Writable({
    write(c, _e, cb) {
      err.push(c.toString())
      cb()
    },
  })
  const result = await main(argv, { stdout, stderr, stdin: Readable.from([]) })
  return { stdout: out.join(''), stderr: err.join(''), exitCode: result.exitCode }
}
