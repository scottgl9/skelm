import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../../src/builders.js'
import type { ExecFn } from '../../src/index.js'
import { TrustEnforcer, resolvePermissions } from '../../src/permissions.js'
import { runPipeline } from '../../src/runner.js'

// Command-line patterns in allowedExecutables. A plain entry (no `*`, no
// whitespace) matches the binary with ANY arguments (backward compatible); an
// entry containing `*` or whitespace is a command-line glob matched against the
// full command line. Path-bearing binaries never match a bare-name entry
// (basename-bypass closed in 0366b65).

function exec(allowedExecutables: string[]): TrustEnforcer {
  return new TrustEnforcer(resolvePermissions(undefined, { allowedExecutables }))
}

describe('canExec — plain entries (backward compatible)', () => {
  it('a bare binary entry allows the binary with any arguments', () => {
    const e = exec(['node'])
    expect(e.canExec('node', 'node -e console.log(1)').allow).toBe(true)
    expect(e.canExec('node', 'node').allow).toBe(true)
  })

  it('a bare entry denies a different binary', () => {
    expect(exec(['node']).canExec('git', 'git status').allow).toBe(false)
  })

  it('a bare entry never matches a path-bearing binary (no basename fallback)', () => {
    expect(exec(['node']).canExec('/tmp/evil/node', '/tmp/evil/node -e x').allow).toBe(false)
  })
})

describe('canExec — command-line glob patterns', () => {
  it('`node *` allows node with arguments but not bare node', () => {
    const e = exec(['node *'])
    expect(e.canExec('node', 'node script.js --flag').allow).toBe(true)
    expect(e.canExec('node', 'node').allow).toBe(false)
  })

  it('`node build*` restricts to commands starting with "node build"', () => {
    const e = exec(['node build*'])
    expect(e.canExec('node', 'node build src').allow).toBe(true)
    expect(e.canExec('node', 'node deploy prod').allow).toBe(false)
  })

  it('a pattern does not match a path-bearing invocation of the same binary', () => {
    // `node *` is anchored at the start, so `/usr/bin/node ...` does not match.
    expect(exec(['node *']).canExec('/usr/bin/node', '/usr/bin/node x').allow).toBe(false)
  })

  it('regex metacharacters in a pattern are escaped (only `*` is a wildcard)', () => {
    const e = exec(['a.b*'])
    expect(e.canExec('a.b', 'a.b c').allow).toBe(true)
    // the `.` is literal, so it must not match any character
    expect(e.canExec('axb', 'axb c').allow).toBe(false)
  })

  it('plain and pattern entries compose (either may grant)', () => {
    const e = exec(['git', 'node build*'])
    expect(e.canExec('git', 'git push origin main').allow).toBe(true) // plain
    expect(e.canExec('node', 'node build x').allow).toBe(true) // pattern
    expect(e.canExec('node', 'node test').allow).toBe(false) // neither
  })
})

describe('ctx.exec honours command-line patterns end to end', () => {
  it('allows node with args under `node *`', async () => {
    const wf = pipeline({
      id: 'exec-pattern-allow',
      steps: [
        code({
          id: 'run',
          permissions: { allowedExecutables: ['node *'] },
          run: async (ctx) =>
            await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.stdout.write("ok")'],
            }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
  })

  it('denies a command that does not match the pattern', async () => {
    const wf = pipeline({
      id: 'exec-pattern-deny',
      steps: [
        code({
          id: 'run',
          permissions: { allowedExecutables: ['node build*'] },
          run: async (ctx) =>
            await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.stdout.write("nope")'],
            }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })
})
