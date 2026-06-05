import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BackendRegistry,
  EventBus,
  type RunEvent,
  type SkelmBackend,
  agent,
  pipeline,
  runPipeline,
} from '../../src/index.js'

const MOCK_SHELL_MCP = fileURLToPath(new URL('./mock-shell-mcp-server.ts', import.meta.url))

// Adversarial coverage of the `mcp` permission dimension. The runner enforces
// allowedMcpServers at attach time; this fixture pins the deny path on
// omission (default-deny) and on explicit-mismatch. The audit row is produced
// by the Runner's permission.denied → audit subscription, exercised in
// runner-audit.test.ts; here we assert the event itself, matching the
// existing executable/tool fixture's pattern.

describe('permission enforcement — MCP attach adversarial', () => {
  function backend(): SkelmBackend {
    return {
      id: 'mcp-attach',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: true,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run() {
        return { text: 'unreachable' }
      },
    }
  }

  function nativeBackend(): SkelmBackend {
    return {
      id: 'native-mcp',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: true,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async run() {
        return { text: 'ok' }
      },
    }
  }

  function workflow(opts: { allow: readonly string[] | undefined }) {
    return pipeline({
      id: `mcp-attach-${opts.allow?.join('-') ?? 'omitted'}`,
      steps: [
        agent({
          id: 'work',
          backend: 'mcp-attach',
          prompt: 'hi',
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
            ...(opts.allow !== undefined && { allowedMcpServers: opts.allow }),
          },
        }),
      ],
    })
  }

  it('denies attach when allowedMcpServers is omitted (default-deny)', async () => {
    const registry = new BackendRegistry()
    registry.register(backend())
    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((e) => seen.push(e))

    const run = await runPipeline(workflow({ allow: undefined }), undefined, {
      backends: registry,
      events,
    })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(run.error?.message).toMatch(/attach MCP server "shell"/)
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'permission.denied',
          stepId: 'work',
          dimension: 'mcp',
        }),
      ]),
    )
  })

  it('denies attach when server id is not in explicit allowlist', async () => {
    const registry = new BackendRegistry()
    registry.register(backend())
    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((e) => seen.push(e))

    const run = await runPipeline(workflow({ allow: ['otherserver'] }), undefined, {
      backends: registry,
      events,
    })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'permission.denied',
          dimension: 'mcp',
        }),
      ]),
    )
  })

  it('denies filesystem MCP roots outside author-declared fsRead/fsWrite for native backends', async () => {
    const registry = new BackendRegistry()
    registry.register(nativeBackend())
    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((e) => seen.push(e))
    const wf = pipeline({
      id: 'native-mcp-fs-root-denied',
      steps: [
        agent({
          id: 'work',
          backend: 'native-mcp',
          prompt: 'hi',
          mcp: [
            {
              id: 'fs-mcp',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/skelm-mcp-fs-root'],
            },
          ],
          permissions: {
            allowedTools: ['*'],
            allowedMcpServers: ['fs-mcp'],
            fsRead: ['/tmp/some-other-root'],
            fsWrite: [],
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, {
      backends: registry,
      events,
      defaultPermissions: {
        allowedTools: ['*'],
        allowedMcpServers: ['fs-mcp'],
        fsRead: ['/'],
        fsWrite: [],
      },
    })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(run.error?.message).toMatch(/filesystem MCP server "fs-mcp"/)
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'permission.denied',
          stepId: 'work',
          dimension: 'fs.read',
        }),
      ]),
    )
  })
})
