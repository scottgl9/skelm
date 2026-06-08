import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createAssetHost } from '../src/assets.js'
import { code, pipeline } from '../src/builders.js'
import { AssetPathError } from '../src/index.js'
import { runPipeline } from '../src/runner.js'

describe('ctx.assets', () => {
  it('loads text, JSON, bytes, existence, and listings relative to pipeline baseDir', async () => {
    const previousCwd = process.cwd()
    const root = await mkdtemp(join(tmpdir(), 'skelm-assets-'))
    const otherCwd = await mkdtemp(join(tmpdir(), 'skelm-assets-cwd-'))
    try {
      await mkdir(join(root, 'assets', 'nested'), { recursive: true })
      await writeFile(join(root, 'assets', 'prompt.txt'), 'hello asset', 'utf8')
      await writeFile(join(root, 'assets', 'config.json'), '{"enabled":true}', 'utf8')
      await writeFile(join(root, 'assets', 'nested', 'bytes.bin'), new Uint8Array([1, 2, 3]))
      // Proves asset resolution uses pipeline baseDir rather than process cwd.
      process.chdir(otherCwd)

      const wf = pipeline({
        id: 'asset-loader',
        baseDir: root,
        steps: [
          code({
            id: 'read',
            run: async (ctx) => ({
              text: await ctx.assets.getText('assets/prompt.txt'),
              json: await ctx.assets.getJson<{ enabled: boolean }>('assets/config.json'),
              bytes: Array.from(await ctx.assets.getBytes('assets/nested/bytes.bin')),
              exists: await ctx.assets.exists('assets/prompt.txt'),
              missing: await ctx.assets.exists('assets/missing.txt'),
              listed: await ctx.assets.list('assets'),
            }),
          }),
        ],
      })

      const run = await runPipeline(wf, undefined)
      expect(run.status).toBe('completed')
      expect(run.output).toEqual({
        text: 'hello asset',
        json: { enabled: true },
        bytes: [1, 2, 3],
        exists: true,
        missing: false,
        listed: ['assets/config.json', 'assets/nested/bytes.bin', 'assets/prompt.txt'],
      })
    } finally {
      process.chdir(previousCwd)
      await rm(root, { recursive: true, force: true })
      await rm(otherCwd, { recursive: true, force: true })
    }
  })

  it('loads assets from when predicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skelm-assets-when-'))
    try {
      await mkdir(join(root, 'assets'), { recursive: true })
      await writeFile(join(root, 'assets', 'enabled.txt'), 'yes', 'utf8')

      const wf = pipeline({
        id: 'asset-when',
        baseDir: root,
        steps: [
          code({
            id: 'conditional',
            when: async (ctx) => (await ctx.assets.getText('assets/enabled.txt')) === 'yes',
            run: () => 'ran',
          }),
        ],
      })

      const run = await runPipeline(wf, undefined)
      expect(run.status).toBe('completed')
      expect(run.output).toBe('ran')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('wraps inaccessible asset roots in AssetPathError', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skelm-assets-missing-root-'))
    await rm(root, { recursive: true, force: true })

    const wf = pipeline({
      id: 'asset-missing-root',
      baseDir: root,
      steps: [
        code({
          id: 'probe',
          run: async (ctx) => {
            try {
              await ctx.assets.getText('assets/prompt.txt')
              return 'resolved'
            } catch (err) {
              return {
                publicError: err instanceof AssetPathError,
                name: err instanceof Error ? err.name : String(err),
              }
            }
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ publicError: true, name: 'AssetPathError' })
  })

  it('retries missing root resolution when the root is created later', async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), 'skelm-assets-lazy-root-'))
    const missingPath = join(missingRoot, 'never-there')
    const host = createAssetHost(missingPath)

    try {
      await expect(host.getText('assets/prompt.txt')).rejects.toBeInstanceOf(AssetPathError)

      await mkdir(missingPath, { recursive: true })
      await mkdir(join(missingPath, 'assets'), { recursive: true })
      await writeFile(join(missingPath, 'assets', 'prompt.txt'), 'ready', 'utf8')

      await expect(host.getText('assets/prompt.txt')).resolves.toBe('ready')
    } finally {
      await rm(missingRoot, { recursive: true, force: true })
    }
  })

  it('denies traversal, absolute paths, and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skelm-assets-secure-'))
    const outside = await mkdtemp(join(tmpdir(), 'skelm-assets-outside-'))
    try {
      await mkdir(join(root, 'assets'), { recursive: true })
      await writeFile(join(root, 'assets', 'ok.txt'), 'safe', 'utf8')
      await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
      await symlink(join(outside, 'secret.txt'), join(root, 'assets', 'secret-link.txt'))

      const wf = pipeline({
        id: 'asset-security',
        baseDir: root,
        steps: [
          code({
            id: 'probe',
            run: async (ctx) => {
              const traversal = await rejects(() => ctx.assets.getText('../secret.txt'))
              const absolute = await rejects(() => ctx.assets.getText(join(outside, 'secret.txt')))
              const symlinkEscape = await rejects(() =>
                ctx.assets.getText('assets/secret-link.txt'),
              )
              return {
                traversal,
                absolute,
                symlinkEscape,
                symlinkExists: await ctx.assets.exists('assets/secret-link.txt'),
                listed: await ctx.assets.list('assets'),
              }
            },
          }),
        ],
      })

      const run = await runPipeline(wf, undefined)
      expect(run.status).toBe('completed')
      expect(run.output).toEqual({
        traversal: 'AssetPathError',
        absolute: 'AssetPathError',
        symlinkEscape: 'AssetPathError',
        symlinkExists: false,
        listed: ['assets/ok.txt'],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

async function rejects(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return 'resolved'
  } catch (err) {
    return err instanceof Error ? err.name : String(err)
  }
}
