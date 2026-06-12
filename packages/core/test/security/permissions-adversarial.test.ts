import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BackendRegistry,
  EventBus,
  PermissionDeniedError,
  type ResolvedPolicy,
  type RunEvent,
  type SkelmBackend,
  agent,
  pipeline,
  runPipeline,
} from '../../src/index.js'

const MOCK_SHELL_MCP = fileURLToPath(new URL('./mock-shell-mcp-server.ts', import.meta.url))

describe('permission enforcement — adversarial', () => {
  it('allows rg but denies bash for wrapped MCP exec tools', async () => {
    const registry = new BackendRegistry()
    const backend: SkelmBackend = {
      id: 'wrapped-exec',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: true,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run(req, ctx) {
        if (req.prompt === 'allowed') {
          const result = await ctx.mcpHost?.invokeTool(
            'shell.exec',
            { command: 'rg --version' },
            ctx.signal,
          )
          return { text: (result?.content[0] as { type: 'text'; text: string }).text }
        }

        await ctx.mcpHost?.invokeTool('shell.exec', { command: 'bash -lc "echo nope"' }, ctx.signal)
        return { text: 'unreachable' }
      },
    }
    registry.register(backend)

    const allowedRun = await runPipeline(workflow('allowed'), undefined, { backends: registry })
    expect(allowedRun.status).toBe('completed')
    expect((allowedRun.output as { text: string }).text).toBe('exec:rg --version')

    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((event) => {
      seen.push(event)
    })

    const deniedRun = await runPipeline(workflow('denied'), undefined, {
      backends: registry,
      events,
    })
    expect(deniedRun.status).toBe('failed')
    expect(deniedRun.error?.name).toBe('PermissionDeniedError')
    expect(deniedRun.error?.message).toMatch(/requested executable "bash"/)
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.denied',
          stepId: 'work',
          tool: 'shell.exec',
          reason: 'not-in-allowlist',
        }),
        expect.objectContaining({
          type: 'permission.denied',
          stepId: 'work',
          dimension: 'executable',
        }),
      ]),
    )
  })

  it('emits permission.denied when the backend defense-in-depth guard throws PermissionDeniedError', async () => {
    // Simulates a backend like Pi RPC that cannot enforce policies itself and
    // rejects any non-undefined ResolvedPolicy from within its own run() method.
    const registry = new BackendRegistry()
    const backend: SkelmBackend = {
      id: 'self-enforcing',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'unsupported',
      },
      async run(_req, ctx) {
        if (ctx.permissions !== undefined) {
          throw new PermissionDeniedError(
            'self-enforcing backend cannot enforce permission policies',
          )
        }
        return { text: 'ok' }
      },
    }
    registry.register(backend)

    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((ev) => seen.push(ev))

    const run = await runPipeline(
      pipeline({
        id: 'defense-in-depth',
        steps: [
          agent({
            id: 'step',
            backend: 'self-enforcing',
            prompt: 'go',
            permissions: { allowedTools: [], networkEgress: 'deny' },
          }),
        ],
      }),
      undefined,
      { backends: registry, events },
    )

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'permission.denied',
          stepId: 'step',
          dimension: 'tool',
        }),
      ]),
    )
  })

  it('applies operator default permissions to a bare agent step', async () => {
    const registry = new BackendRegistry()
    let seenPolicy: ResolvedPolicy | undefined
    const backend: SkelmBackend = {
      id: 'capture',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run(req) {
        seenPolicy = req.permissions
        return { text: 'ok' }
      },
    }
    registry.register(backend)

    const run = await runPipeline(
      pipeline({
        id: 'bare-agent-defaults',
        steps: [agent({ id: 'step', backend: 'capture', prompt: 'go' })],
      }),
      undefined,
      {
        backends: registry,
        defaultPermissions: {
          allowedTools: [],
          fsRead: [],
          fsWrite: [],
          networkEgress: 'deny',
        },
      },
    )

    expect(run.status).toBe('completed')
    expect(seenPolicy).toBeDefined()
    expect(seenPolicy?.allowedTools.star).toBe(false)
    expect(seenPolicy?.allowedTools.exact.size).toBe(0)
    expect(seenPolicy?.fsRead.size).toBe(0)
    expect(seenPolicy?.fsWrite.size).toBe(0)
    expect(seenPolicy?.networkEgress).toBe('deny')
  })

  it('names the tool-class dimensions when a toolPermissions:unsupported backend is asked to enforce them', async () => {
    // Regression: the pre-flight refusal for an `'unsupported'` backend used to
    // throw a generic "cannot enforce declared permissions" message that did
    // not name what could not be enforced — unlike the backend's own
    // defense-in-depth refusal. A non-empty grant (allowedTools/fsRead) survives
    // into the resolved policy and trips this pre-flight path, so the surfaced
    // message must state the capability boundary explicitly.
    const registry = new BackendRegistry()
    const backend: SkelmBackend = {
      id: 'pi',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'unsupported',
      },
      async run() {
        // Should never run: the pre-flight capability check refuses first.
        return { text: 'should not reach' }
      },
    }
    registry.register(backend)

    const run = await runPipeline(
      pipeline({
        id: 'unsupported-named-dimensions',
        steps: [
          agent({
            id: 'step',
            backend: 'pi',
            prompt: 'go',
            permissions: {
              allowedTools: ['fs.read'],
              fsRead: ['./'],
              networkEgress: 'deny',
            },
          }),
        ],
      }),
      undefined,
      { backends: registry },
    )

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendCapabilityError')
    expect(run.error?.message).toMatch(
      /cannot enforce tool, executable, filesystem, MCP, or skill permissions/,
    )
  })

  it('does NOT fail-close a toolPermissions:unsupported backend for operator-default dimensions', async () => {
    // Regression: the backend-capability fail-close used to be computed from the
    // fully-RESOLVED policy, so an operator's project-default permissions
    // (defaultPermissions — tool/executable/fs dimensions) tripped it on a
    // toolPermissions:'unsupported' backend (e.g. Pi) even though the AUTHOR only
    // asked for networkEgress. That made such backends fail closed on entry
    // points that apply defaults (POST /runs, triggers) while working on the ones
    // that don't (cli, /pipelines/:id/run) — and broke their egress on the former.
    // The check must consider only AUTHOR-declared dimensions; operator defaults
    // the backend can't enforce are advisory (egress is still proxy-enforced).
    const registry = new BackendRegistry()
    let ran = false
    const backend: SkelmBackend = {
      id: 'pi',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'unsupported',
      },
      async run() {
        ran = true
        return { text: 'ok' }
      },
    }
    registry.register(backend)

    const run = await runPipeline(
      pipeline({
        id: 'unsupported-operator-defaults',
        steps: [
          agent({
            id: 'step',
            backend: 'pi',
            prompt: 'go',
            // Author asks ONLY for egress — pi relies on the gateway egress proxy.
            permissions: { networkEgress: 'allow' },
          }),
        ],
      }),
      undefined,
      {
        backends: registry,
        // Operator project-default ceiling with tool-class dimensions pi cannot
        // enforce. These must NOT fail-close the run.
        defaultPermissions: {
          allowedExecutables: ['git'],
          allowedTools: ['fs.read'],
          fsRead: ['/'],
        },
        // Gateway egress proxy present (enforces the network dimension
        // out-of-band, so the author's networkEgress doesn't fail-close either).
        registerEgressToken: () => 'tok',
        getProxyEnv: () => ({ HTTP_PROXY: 'http://127.0.0.1:1' }),
      },
    )

    expect(run.status).toBe('completed')
    expect(ran).toBe(true)
  })

  it('still fails closed when the AUTHOR declares tool perms on a toolPermissions:unsupported backend, even with an egress proxy', async () => {
    // The security contract preserved: an author-declared tool/fs restriction on
    // an incapable backend must still fail closed so the author is warned it
    // can't be honoured — independent of operator defaults or the egress proxy.
    const registry = new BackendRegistry()
    const backend: SkelmBackend = {
      id: 'pi',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'unsupported',
      },
      async run() {
        return { text: 'should not reach' }
      },
    }
    registry.register(backend)

    const run = await runPipeline(
      pipeline({
        id: 'unsupported-author-tools',
        steps: [
          agent({
            id: 'step',
            backend: 'pi',
            prompt: 'go',
            permissions: { allowedTools: ['fs.read'], fsRead: ['./'], networkEgress: 'allow' },
          }),
        ],
      }),
      undefined,
      {
        backends: registry,
        registerEgressToken: () => 'tok',
        getProxyEnv: () => ({ HTTP_PROXY: 'http://127.0.0.1:1' }),
      },
    )

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendCapabilityError')
  })

  it('allows explicit advisory backends while emitting operator-visible advisory events', async () => {
    const registry = new BackendRegistry()
    let ran = false
    const backend: SkelmBackend = {
      id: 'acp-advisory',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'advisory',
      },
      async run() {
        ran = true
        return { text: 'ok' }
      },
    }
    registry.register(backend)
    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((event) => seen.push(event))

    const run = await runPipeline(
      pipeline({
        id: 'advisory-permissions',
        steps: [
          agent({
            id: 'step',
            backend: 'acp-advisory',
            prompt: 'go',
            permissions: {
              allowedTools: ['fs.read'],
              allowedExecutables: ['git'],
              fsRead: ['./'],
              networkEgress: 'allow',
            },
          }),
        ],
      }),
      undefined,
      {
        backends: registry,
        events,
        registerEgressToken: () => 'tok',
        getProxyEnv: () => ({ HTTP_PROXY: 'http://127.0.0.1:1' }),
      },
    )

    expect(run.status).toBe('completed')
    expect(ran).toBe(true)
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'permission.advisory',
          stepId: 'step',
          backendId: 'acp-advisory',
          dimensions: expect.arrayContaining(['tool', 'executable', 'fs.read']),
        }),
      ]),
    )
  })

  it('still fails closed for advisory network permissions without the gateway egress proxy', async () => {
    const registry = new BackendRegistry()
    const backend: SkelmBackend = {
      id: 'acp-advisory',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'advisory',
      },
      async run() {
        return { text: 'should not reach' }
      },
    }
    registry.register(backend)

    const run = await runPipeline(
      pipeline({
        id: 'advisory-network-no-proxy',
        steps: [
          agent({
            id: 'step',
            backend: 'acp-advisory',
            prompt: 'go',
            permissions: { networkEgress: 'allow' },
          }),
        ],
      }),
      undefined,
      { backends: registry },
    )

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendCapabilityError')
    expect(run.error?.message).toMatch(/without the gateway egress proxy/)
  })
})

function workflow(prompt: string) {
  return pipeline({
    id: `permissions-${prompt}`,
    steps: [
      agent({
        id: 'work',
        backend: 'wrapped-exec',
        prompt,
        mcp: [
          {
            id: 'shell',
            transport: 'stdio',
            command: 'node',
            args: [MOCK_SHELL_MCP],
          },
        ],
        permissions: {
          allowedTools: ['shell.exec'],
          allowedExecutables: ['rg'],
          allowedMcpServers: ['shell'],
        },
      }),
    ],
  })
}
