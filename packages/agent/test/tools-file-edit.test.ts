import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePermissions } from '@skelm/core/permissions'
import { TrustEnforcer } from '@skelm/core/permissions'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUILTIN_TOOLS, type ToolExecutionContext } from '../src/tools.js'

// Granted-path success + adversarial denied-path for the structured file-edit
// tools (read_file / write_file / edit_file). Denial fires when fsRead/fsWrite
// is not granted; no side effect is written on the deny path.

function tool(name: string) {
  const t = BUILTIN_TOOLS.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool ${name} not found`)
  return t
}

function ctxFor(
  dir: string,
  opts: { fsRead?: string[]; fsWrite?: string[] },
): ToolExecutionContext {
  const policy = resolvePermissions(
    {
      allowedTools: ['*'],
      fsRead: opts.fsRead ?? [],
      fsWrite: opts.fsWrite ?? [],
      networkEgress: 'deny',
    },
    undefined,
  )
  return { cwd: dir, agentDefRoot: dir, enforcer: new TrustEnforcer(policy) }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skelm-fe-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('read_file', () => {
  it('reads a line range with line-number prefixes when fsRead is granted', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\nthree\nfour\n')
    const ctx = ctxFor(dir, { fsRead: [dir] })
    const r = await tool('read_file').handler({ path: file, startLine: 2, endLine: 3 }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toBe('2\ttwo\n3\tthree')
  })

  it('denies when fsRead is not granted', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'secret')
    const ctx = ctxFor(dir, { fsRead: [] })
    const r = await tool('read_file').handler({ path: file }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Permission denied')
    expect(r.content).not.toContain('secret')
  })
})

describe('write_file', () => {
  it('writes when fsWrite is granted', async () => {
    const file = join(dir, 'out.txt')
    const ctx = ctxFor(dir, { fsWrite: [dir] })
    const r = await tool('write_file').handler({ path: file, content: 'hello' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(await readFile(file, 'utf-8')).toBe('hello')
  })

  it('denies and writes nothing when fsWrite is not granted', async () => {
    const file = join(dir, 'out.txt')
    const ctx = ctxFor(dir, { fsWrite: [], fsRead: [dir] })
    const r = await tool('write_file').handler({ path: file, content: 'hello' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Permission denied')
    await expect(readFile(file, 'utf-8')).rejects.toBeTruthy()
  })
})

describe('edit_file', () => {
  it('find/replace edits in place when fsWrite is granted', async () => {
    const file = join(dir, 'src.txt')
    await writeFile(file, 'const x = 1')
    const ctx = ctxFor(dir, { fsWrite: [dir] })
    const r = await tool('edit_file').handler({ path: file, find: '1', replace: '2' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(await readFile(file, 'utf-8')).toBe('const x = 2')
  })

  it('refuses an ambiguous find without writing', async () => {
    const file = join(dir, 'src.txt')
    await writeFile(file, 'a a a')
    const ctx = ctxFor(dir, { fsWrite: [dir] })
    const r = await tool('edit_file').handler({ path: file, find: 'a', replace: 'b' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('occurs 3 times')
    expect(await readFile(file, 'utf-8')).toBe('a a a')
  })

  it('replaceAll edits every occurrence', async () => {
    const file = join(dir, 'src.txt')
    await writeFile(file, 'a a a')
    const ctx = ctxFor(dir, { fsWrite: [dir] })
    const r = await tool('edit_file').handler(
      { path: file, find: 'a', replace: 'b', replaceAll: true },
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(await readFile(file, 'utf-8')).toBe('b b b')
  })

  it('line-range edits swap the targeted lines', async () => {
    const file = join(dir, 'src.txt')
    await writeFile(file, 'one\ntwo\nthree')
    const ctx = ctxFor(dir, { fsWrite: [dir] })
    const r = await tool('edit_file').handler(
      { path: file, startLine: 2, endLine: 2, replace: 'TWO' },
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(await readFile(file, 'utf-8')).toBe('one\nTWO\nthree')
  })

  it('denies and writes nothing when fsWrite is not granted', async () => {
    const file = join(dir, 'src.txt')
    await writeFile(file, 'const x = 1')
    const ctx = ctxFor(dir, { fsWrite: [], fsRead: [dir] })
    const r = await tool('edit_file').handler({ path: file, find: '1', replace: '2' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Permission denied')
    expect(await readFile(file, 'utf-8')).toBe('const x = 1')
  })

  it('rejects when neither edit mode is fully specified', async () => {
    const file = join(dir, 'src.txt')
    await writeFile(file, 'x')
    const ctx = ctxFor(dir, { fsWrite: [dir] })
    const r = await tool('edit_file').handler({ path: file }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('exactly one edit mode')
  })
})
