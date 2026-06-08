import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RegistryError } from '../../src/errors.js'
import { discoverWorkflowPackage, discoverWorkflowPackages } from '../../src/workflows/packages.js'
import { WorkflowRegistry } from '../../src/workflows/registry.js'

let tempRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'skelm-workflow-packages-'))
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('workflow package discovery', () => {
  it('discovers workflow package metadata from an explicit package root', async () => {
    const root = await createPackage('triage-pack', {
      id: 'acme.triage',
      name: 'Triage workflows',
      version: '1.2.3',
      workflows: [
        {
          id: 'triage.issue',
          path: './workflows/issue.workflow.mts',
          export: 'issueWorkflow',
          name: 'Issue triage',
        },
      ],
      assets: './assets',
      docs: './README.md',
    })

    const pkg = await discoverWorkflowPackage(root)

    expect(pkg.id).toBe('acme.triage')
    expect(pkg.packageName).toBe('triage-pack')
    expect(pkg.name).toBe('Triage workflows')
    expect(pkg.version).toBe('1.2.3')
    expect(pkg.packageRoot).toBe(root)
    expect(pkg.workflows).toEqual([
      {
        id: 'triage.issue',
        path: './workflows/issue.workflow.mts',
        absolutePath: join(root, 'workflows/issue.workflow.mts'),
        exportName: 'issueWorkflow',
        name: 'Issue triage',
      },
    ])
    expect(pkg.assetsPath).toBe(join(root, 'assets'))
    expect(pkg.docsPath).toBe(join(root, 'README.md'))
  })

  it('reports a missing workflow package manifest', async () => {
    const root = join(tempRoot, 'missing')
    await writeFile(join(tempRoot, 'missing-package-root'), '')
    await mkdirPackage(root, { name: 'plain-package', version: '1.0.0' })

    await expect(discoverWorkflowPackage(root)).rejects.toThrow('missing skelm.workflowPackage')
  })

  it('collects duplicate package ids without scanning unrelated roots', async () => {
    const first = await createPackage('one', {
      id: 'acme.shared',
      workflows: [{ id: 'one.workflow', path: './workflows/one.workflow.mts' }],
    })
    const second = await createPackage('two', {
      id: 'acme.shared',
      workflows: [{ id: 'two.workflow', path: './workflows/two.workflow.mts' }],
    })

    const result = await discoverWorkflowPackages([first, second])

    expect(result.packages.map((pkg) => pkg.id)).toEqual(['acme.shared'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toBeInstanceOf(RegistryError)
    expect(result.errors[0].message).toContain("id 'acme.shared' is already discovered")
  })

  it('rejects duplicate workflow ids inside a package manifest', async () => {
    const root = await createPackage('dupe-workflows', {
      id: 'acme.dupe',
      workflows: [
        { id: 'same.workflow', path: './workflows/one.workflow.mts' },
        { id: 'same.workflow', path: './workflows/two.workflow.mts' },
      ],
    })

    await expect(discoverWorkflowPackage(root)).rejects.toThrow(
      "declares duplicate workflow id 'same.workflow'",
    )
  })

  it('keeps package-relative paths stable regardless of process cwd', async () => {
    const root = await createPackage('cwd-stable', {
      id: 'acme.cwd',
      workflows: [{ id: 'cwd.workflow', path: './workflows/cwd.workflow.mts' }],
    })
    const originalCwd = process.cwd()

    try {
      process.chdir(tempRoot)
      const pkg = await discoverWorkflowPackage(root)
      const registry = new WorkflowRegistry()
      registry.registerPackage(pkg)

      expect(registry.resolvePackagePath('acme.cwd', './prompts/review.md')).toBe(
        join(root, 'prompts/review.md'),
      )
      expect(() => registry.resolvePackagePath('acme.cwd', '../escape.md')).toThrow(
        'outside the package root',
      )
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('rejects duplicate workflow ids across registered packages', async () => {
    const first = await discoverWorkflowPackage(
      await createPackage('first', {
        id: 'acme.first',
        workflows: [{ id: 'shared.workflow', path: './workflows/shared.workflow.mts' }],
      }),
    )
    const second = await discoverWorkflowPackage(
      await createPackage('second', {
        id: 'acme.second',
        workflows: [{ id: 'shared.workflow', path: './workflows/shared.workflow.mts' }],
      }),
    )
    const registry = new WorkflowRegistry()

    registry.registerPackage(first)

    expect(() => registry.registerPackage(second)).toThrow(
      "declares duplicate workflow id 'shared.workflow'",
    )
  })
})

async function createPackage(
  directoryName: string,
  workflowPackage: Record<string, unknown>,
): Promise<string> {
  const root = join(tempRoot, directoryName)
  await mkdirPackage(root, {
    name: directoryName,
    version: '1.0.0',
    skelm: { workflowPackage },
  })
  return root
}

async function mkdirPackage(root: string, packageJson: Record<string, unknown>): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await import('node:fs/promises').then(({ mkdir }) => mkdir(root, { recursive: true }))
  await writeFile(join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
}
