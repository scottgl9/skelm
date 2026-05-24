import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { parseArgv } from '../src/argv.js'
import { EXIT } from '../src/exit-codes.js'
import { HELP_TEXT } from '../src/help.js'
import { mcpServeCommand } from '../src/mcp-serve.js'

describe('mcp serve', () => {
  it('parseArgv recognizes mcp serve', () => {
    expect(parseArgv(['mcp', 'serve', 'foo.workflow.mts', '--port', '3000'])).toEqual({
      command: 'mcp',
      positional: ['serve', 'foo.workflow.mts'],
      flags: { port: '3000' },
    })
  })

  it('mcpServeCommand exits gracefully when no workflows are discovered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-mcp-empty-'))
    const previousCwd = process.cwd()
    process.chdir(dir)
    try {
      const result = await invokeCommand([])
      expect(result.exitCode).toBe(EXIT.OK)
      expect(result.stdout).toContain('No workflows discovered.')
      expect(result.stderr).toBe('')
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('help text includes mcp serve', () => {
    expect(HELP_TEXT).toContain('skelm mcp serve [workflow.mts...]')
  })
})

async function invokeCommand(workflows: string[]) {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutChunks.push(chunk.toString())
      cb()
    },
  })
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrChunks.push(chunk.toString())
      cb()
    },
  })
  const result = await mcpServeCommand({ workflows }, { stdout, stderr, stdin: Readable.from([]) })
  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode: result.exitCode,
  }
}
