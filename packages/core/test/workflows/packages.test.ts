import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RegistryError } from '../../src/errors.js'
import {
  discoverWorkflowPackage,
  discoverWorkflowPackages,
  resolveWorkflowPackagePath,
} from '../../src/workflows/packages.js'
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

  it('collects duplicate workflow ids across discovered packages', async () => {
    const first = await createPackage('first-discovered', {
      id: 'acme.first-discovered',
      workflows: [{ id: 'shared.workflow', path: './workflows/one.workflow.mts' }],
    })
    const second = await createPackage('second-discovered', {
      id: 'acme.second-discovered',
      workflows: [{ id: 'shared.workflow', path: './workflows/two.workflow.mts' }],
    })

    const result = await discoverWorkflowPackages([first, second])

    expect(result.packages.map((pkg) => pkg.id)).toEqual(['acme.first-discovered'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toBeInstanceOf(RegistryError)
    expect(result.errors[0].message).toContain(
      "workflow id 'shared.workflow' already declared by package 'acme.first-discovered'",
    )
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

  it('normalizes explicit package roots before resolving package-relative paths', async () => {
    const root = await createPackage('absolute-root', {
      id: 'acme.absolute',
      workflows: [{ id: 'absolute.workflow', path: './workflows/absolute.workflow.mts' }],
    })
    const pkg = await discoverWorkflowPackage(root)
    const registry = new WorkflowRegistry()

    registry.registerPackage(pkg)

    expect(isAbsolute(pkg.packageRoot)).toBe(true)
    expect(registry.resolvePackagePath('acme.absolute', './prompts/review.md')).toBe(
      join(root, 'prompts/review.md'),
    )
    expect(() => registry.resolvePackagePath('acme.absolute', '../escape.md')).toThrow(
      'outside the package root',
    )
  })

  it('resolves standalone package-relative paths inside a discovered package', async () => {
    const pkg = await discoverWorkflowPackage(
      await createPackage('standalone-resolve', {
        id: 'acme.standalone',
        workflows: [{ id: 'standalone.workflow', path: './workflows/standalone.workflow.mts' }],
      }),
    )

    expect(resolveWorkflowPackagePath(pkg, './assets/prompt.md')).toBe(
      join(pkg.packageRoot, 'assets/prompt.md'),
    )
    expect(() => resolveWorkflowPackagePath(pkg, '/tmp/escape.md')).toThrow(
      "declares invalid path path '/tmp/escape.md'",
    )
    expect(() => resolveWorkflowPackagePath(pkg, '../escape.md')).toThrow(
      'outside the package root',
    )
  })

  it('rejects empty optional manifest strings', async () => {
    const root = await createPackage('empty-strings', {
      id: 'acme.empty',
      name: '',
      workflows: [{ id: 'empty.workflow', path: './workflows/empty.workflow.mts' }],
    })

    await expect(discoverWorkflowPackage(root)).rejects.toThrow('skelm.workflowPackage.name')
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
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
}
