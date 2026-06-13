import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GatewayContext } from '../../src/lifecycle/gateway-types.js'
import { materializePathWorkflow } from '../../src/workflows/path-materialization.js'
import type {
  MaterializeTreeInput,
  WorkflowArtifactService,
} from '../../src/workflows/workflow-artifact-service.js'

// Capture the MaterializeTreeInput so we can assert which source root the
// materializer was pointed at — the regression hinges on this choice.
function captureGateway(): {
  gateway: GatewayContext
  inputs: MaterializeTreeInput[]
} {
  const inputs: MaterializeTreeInput[] = []
  const service = {
    async materializeTree(input: MaterializeTreeInput) {
      inputs.push(input)
      return { artifactDir: input.sourceRoot, entryPath: input.entryPath }
    },
  } as unknown as WorkflowArtifactService
  const gateway = {
    getWorkflowArtifactService: () => service,
  } as unknown as GatewayContext
  return { gateway, inputs }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skelm-mat-src-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('materializePathWorkflow source-root selection', () => {
  it('roots an installed-package entry at its .skelm/packages version dir', async () => {
    const pkgDir = join(root, '.skelm', 'packages', '@scope__name', '1.0.0')
    await mkdir(join(pkgDir, 'workflows'), { recursive: true })
    await writeFile(join(pkgDir, 'skelm.package.json'), '{}')
    const entry = join(pkgDir, 'workflows', 'wf.ts')
    await writeFile(entry, 'export default {}')
    // A project-root config would otherwise pull the source root up to the
    // project tree, which excludes `.skelm` and drops the entry.
    await writeFile(join(root, 'skelm.config.mjs'), 'export default {}')

    const { gateway, inputs } = captureGateway()
    await materializePathWorkflow(gateway, { id: 'pkg', path: entry })

    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.sourceRoot).toBe(pkgDir)
    expect(inputs[0]?.configPath).toBeUndefined()
  })

  it('roots a plain project workflow at its config dir (unchanged behavior)', async () => {
    await mkdir(join(root, 'flows'), { recursive: true })
    const entry = join(root, 'flows', 'wf.ts')
    await writeFile(entry, 'export default {}')
    await writeFile(join(root, 'skelm.config.mjs'), 'export default {}')

    const { gateway, inputs } = captureGateway()
    await materializePathWorkflow(gateway, { id: 'proj', path: entry })

    expect(inputs[0]?.sourceRoot).toBe(root)
  })

  it('does not treat a non-package .skelm file as a package root', async () => {
    // A `.skelm` path without the `packages/<name>/<version>` manifest layout
    // must not be mistaken for an installed package.
    const dir = join(root, '.skelm', 'cache', 'foo')
    await mkdir(dir, { recursive: true })
    const entry = join(dir, 'wf.ts')
    await writeFile(entry, 'export default {}')

    const { gateway, inputs } = captureGateway()
    await materializePathWorkflow(gateway, { id: 'cache', path: entry })

    expect(inputs[0]?.sourceRoot).toBe(dir)
  })
})
