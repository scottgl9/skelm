import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPackageSpec } from '../src/run.js'

let dir: string
let priorCwd: string

beforeEach(async () => {
  priorCwd = process.cwd()
  dir = await mkdtemp(join(tmpdir(), 'skelm-run-spec-'))
  process.chdir(dir)
})

afterEach(async () => {
  process.chdir(priorCwd)
  await rm(dir, { recursive: true, force: true })
})

describe('isPackageSpec', () => {
  it('accepts unscoped name/entry specs when no real path exists', () => {
    expect(isPackageSpec('hello/report')).toBe(true)
  })

  it('preserves real-path precedence for existing unscoped paths', async () => {
    await writeFile(join(dir, 'hello'), 'plain file', 'utf8')
    expect(isPackageSpec('hello')).toBe(false)
  })

  it('treats existing nested paths as filesystem targets, not package specs', async () => {
    await mkdir(join(dir, 'hello'))
    await writeFile(join(dir, 'hello', 'report'), 'plain file', 'utf8')
    expect(isPackageSpec('hello/report')).toBe(false)
  })

  it('keeps bare unscoped names path-first unless they carry a version', () => {
    expect(isPackageSpec('hello')).toBe(false)
    expect(isPackageSpec('hello@1.2.3')).toBe(true)
  })

  it('keeps extension-bearing args on the filesystem path path', () => {
    expect(isPackageSpec('hello/report.workflow.ts')).toBe(false)
  })
})
