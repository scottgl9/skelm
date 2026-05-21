import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSystemdUnit } from '../src/gateway.js'

describe('systemd unit template', () => {
  it('embeds absolute paths to node and the skelm bin in ExecStart/ExecReload', () => {
    const unit = buildSystemdUnit()

    const execStart = unit.match(/^ExecStart=(.+)$/m)?.[1] ?? ''
    const execReload = unit.match(/^ExecReload=(.+)$/m)?.[1] ?? ''
    expect(execStart).not.toBe('')
    expect(execReload).not.toBe('')

    const [startNode, startBin, ...startArgs] = execStart.split(' ')
    expect(startNode).toBeDefined()
    expect(startBin).toBeDefined()
    expect(isAbsolute(startNode as string)).toBe(true)
    expect(isAbsolute(startBin as string)).toBe(true)
    expect(startArgs).toEqual(['gateway', 'start', '--foreground'])

    const [reloadNode, reloadBin, ...reloadArgs] = execReload.split(' ')
    expect(reloadNode).toBeDefined()
    expect(reloadBin).toBeDefined()
    expect(isAbsolute(reloadNode as string)).toBe(true)
    expect(isAbsolute(reloadBin as string)).toBe(true)
    expect(reloadArgs).toEqual(['gateway', 'reload'])
  })

  it('does NOT rely on `/usr/bin/env skelm` (PATH-dependent — breaks under systemd)', () => {
    const unit = buildSystemdUnit()
    expect(unit).not.toContain('/usr/bin/env skelm')
  })
})
