import { runPipeline } from '@skelm/core'
import { describe, expect, it } from 'vitest'

import { createCodingAgentWorkflow } from '../src/workflow.js'
import { fixtureRepo, makeScriptedBackend, registryWith } from './helpers.js'

describe('createCodingAgentWorkflow (deterministic, stubbed backend)', () => {
  it('reads project instructions and infers the stack before the agent step', async () => {
    const backend = makeScriptedBackend()
    const wf = createCodingAgentWorkflow({
      workspace: fixtureRepo(),
      profile: { executableProfiles: ['nodeBuild'] },
    })

    const run = await runPipeline(
      wf,
      { task: 'add a subtract function' },
      {
        backends: registryWith(backend),
        executableProfiles: { nodeBuild: { executables: ['node', 'pnpm'] } },
      },
    )

    expect(run.status).toBe('completed')
    const out = run.output as {
      stack: string
      instructionSources: readonly string[]
      summary: string
    }
    expect(out.stack).toBe('node-pnpm')
    expect(out.instructionSources).toContain('AGENTS.md')
    expect(out.summary).toContain('validation passed')

    // The agent saw the project's own instructions in its prompt.
    expect(backend.calls).toHaveLength(1)
    const prompt = backend.calls[0]?.prompt
    expect(typeof prompt).toBe('string')
    expect(prompt as string).toContain('Demo Repo')
    expect(prompt as string).toContain('add a subtract function')
  })

  it('withholds PR-only executable profiles when PR mode is off', async () => {
    const backend = makeScriptedBackend()
    const wf = createCodingAgentWorkflow({
      workspace: fixtureRepo(),
      profile: {
        executableProfiles: ['nodeBuild'],
        prExecutableProfiles: ['gitReadOnly'],
        allowHosts: [],
      },
    })

    const run = await runPipeline(
      wf,
      { task: 'noop' },
      {
        backends: registryWith(backend),
        // The operator-defined profiles the workflow references by name.
        executableProfiles: {
          gitReadOnly: { executables: ['git'] },
          nodeBuild: { executables: ['node', 'pnpm'] },
        },
      },
    )

    expect(run.status).toBe('completed')
    const policy = backend.calls[0]?.permissions
    expect(policy).toBeDefined()
    expect([...(policy?.allowedExecutables ?? [])].sort()).toEqual(['node', 'pnpm'])
  })

  it('respects the harness budget by forwarding it to the agent step', async () => {
    // The budget lives on the backend instance in production; here we assert
    // the workflow forwards maxTurns onto the step so a runaway loop is bounded.
    const backend = makeScriptedBackend()
    const wf = createCodingAgentWorkflow({
      workspace: fixtureRepo(),
      maxTurns: 12,
      profile: { executableProfiles: ['nodeBuild'] },
    })
    const step = wf.steps.find((s) => s.id === 'implement')
    expect(step?.kind).toBe('agent')
    expect((step as { maxTurns?: number }).maxTurns).toBe(12)

    const run = await runPipeline(
      wf,
      { task: 'x' },
      {
        backends: registryWith(backend),
        executableProfiles: { nodeBuild: { executables: ['node', 'pnpm'] } },
      },
    )
    expect(run.status).toBe('completed')
  })

  it('defaults PR-opening OFF and does not instruct the agent to open a PR', async () => {
    const backend = makeScriptedBackend()
    const wf = createCodingAgentWorkflow({
      workspace: fixtureRepo(),
      profile: { executableProfiles: ['nodeBuild'] },
    })
    const run = await runPipeline(
      wf,
      { task: 'x' },
      {
        backends: registryWith(backend),
        executableProfiles: { nodeBuild: { executables: ['node', 'pnpm'] } },
      },
    )

    const out = run.output as { prEnabled: boolean }
    expect(out.prEnabled).toBe(false)
    const prompt = backend.calls[0]?.prompt as string
    expect(prompt).toContain('Do NOT open a pull request')
  })

  it('gates PR-opening behind explicit pr.enabled config', async () => {
    const backend = makeScriptedBackend()
    const wf = createCodingAgentWorkflow({
      workspace: fixtureRepo(),
      profile: {
        executableProfiles: ['nodeBuild'],
        prExecutableProfiles: ['gitReadOnly'],
        allowHosts: ['api.github.com'],
      },
      pr: { enabled: true },
    })
    const run = await runPipeline(
      wf,
      { task: 'x' },
      {
        backends: registryWith(backend),
        executableProfiles: {
          gitReadOnly: { executables: ['git'] },
          nodeBuild: { executables: ['node', 'pnpm'] },
        },
      },
    )

    const out = run.output as { prEnabled: boolean }
    expect(out.prEnabled).toBe(true)
    const prompt = backend.calls[0]?.prompt as string
    expect(prompt).toContain('MAY commit on a branch and open a pull request')
    const policy = backend.calls[0]?.permissions
    expect([...(policy?.allowedExecutables ?? [])].sort()).toEqual(['git', 'node', 'pnpm'])
  })

  it('rejects a relative workspace path at build time', () => {
    expect(() => createCodingAgentWorkflow({ workspace: './relative' })).toThrow(/absolute path/)
  })
})
