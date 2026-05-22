import type { Readable, Writable } from 'node:stream'
import type { BackendRegistry, JsonRpcRequest, JsonRpcResponse, Pipeline } from '@skelm/core'
import { JsonRpcLineTransport, MCP_PROTOCOL_VERSION, runPipeline } from '@skelm/core'
import { exportInputSchema } from './schema-export.js'

export const MCP_SERVER_NAME = 'skelm-mcp'
export const MCP_SERVER_VERSION = '0.4.3'

export interface McpServeOptions {
  workflows: readonly string[]
  projectRoot: string
  input?: Readable
  output?: Writable
  pipelines?: readonly Pipeline[]
  backends?: BackendRegistry
  workflowLoader?: (workflowPath: string) => Promise<Pipeline>
}

interface LoadedPipeline {
  toolName: string
  pipeline: Pipeline
}

export class McpServer {
  private readonly input: Readable
  private readonly transport: JsonRpcLineTransport
  private readonly workflows: readonly string[]
  private readonly pipelines: readonly Pipeline[]
  private readonly backends: BackendRegistry | undefined
  private readonly workflowLoader: (workflowPath: string) => Promise<Pipeline>
  private cachedPipelines: LoadedPipeline[] | null = null
  private servePromise: Promise<void> | null = null
  private stopResolver: (() => void) | null = null
  private stopped = false

  constructor(options: McpServeOptions) {
    this.input = options.input ?? process.stdin
    this.transport = new JsonRpcLineTransport(this.input, options.output ?? process.stdout)
    this.workflows = options.workflows
    this.pipelines = options.pipelines ?? []
    this.backends = options.backends
    this.workflowLoader = options.workflowLoader ?? defaultWorkflowLoader
  }

  async serve(): Promise<void> {
    if (this.servePromise !== null) return await this.servePromise

    this.servePromise = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.transport.removeListener('request', onRequest)
        this.transport.removeListener('notification', onNotification)
        this.transport.removeListener('error', onError)
        this.transport.removeListener('close', onClose)
        this.input.removeListener('end', onClose)
      }

      const finish = () => {
        if (this.stopped) return
        this.stopped = true
        cleanup()
        this.stopResolver = null
        resolve()
      }

      const onRequest = (message: JsonRpcRequest) => {
        void this.handleRequest(message)
      }
      const onNotification = (message: { method: string }) => {
        if (message.method === 'notifications/initialized') return
      }
      const onError = (error: Error) => {
        cleanup()
        this.stopResolver = null
        reject(error)
      }
      const onClose = () => finish()

      this.stopResolver = finish
      this.transport.on('request', onRequest)
      this.transport.on('notification', onNotification)
      this.transport.on('error', onError)
      this.transport.on('close', onClose)
      this.input.on('end', onClose)
    })

    return await this.servePromise
  }

  async stop(): Promise<void> {
    this.stopResolver?.()
    if (this.servePromise !== null) await this.servePromise
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    try {
      switch (message.method) {
        case 'initialize':
          this.respond(message.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: MCP_SERVER_NAME,
              version: MCP_SERVER_VERSION,
            },
          })
          return
        case 'tools/list': {
          const pipelines = await this.loadPipelines()
          this.respond(message.id, {
            tools: pipelines.map(({ toolName, pipeline }) => ({
              name: toolName,
              description: pipeline.description ?? `Run the ${pipeline.id} pipeline`,
              inputSchema: exportInputSchema(pipeline.inputSchema),
            })),
          })
          return
        }
        case 'tools/call': {
          const params = message.params as { name?: unknown; arguments?: unknown } | undefined
          if (typeof params?.name !== 'string') {
            this.respond(message.id, {
              content: [{ type: 'text', text: 'tool name is required' }],
              isError: true,
            })
            return
          }

          const match = (await this.loadPipelines()).find(
            ({ toolName }) => toolName === params.name,
          )
          if (match === undefined) {
            this.respond(message.id, {
              content: [{ type: 'text', text: `unknown tool: ${params.name}` }],
              isError: true,
            })
            return
          }

          try {
            const run = await runPipeline(match.pipeline, params.arguments, {
              ...(this.backends !== undefined ? { backends: this.backends } : {}),
            })
            if (run.status !== 'completed') {
              const messageText =
                run.error?.message ?? `pipeline ${match.pipeline.id} did not complete`
              this.respond(message.id, {
                content: [{ type: 'text', text: messageText }],
                isError: true,
              })
              return
            }
            this.respond(message.id, {
              content: [{ type: 'text', text: JSON.stringify(run.output) }],
            })
          } catch (error) {
            this.respond(message.id, {
              content: [{ type: 'text', text: errorMessage(error) }],
              isError: true,
            })
          }
          return
        }
        default:
          this.respondError(message.id, -32601, `Method not found: ${message.method}`)
      }
    } catch (error) {
      this.respondError(message.id, -32000, errorMessage(error))
    }
  }

  private async loadPipelines(): Promise<readonly LoadedPipeline[]> {
    if (this.cachedPipelines !== null) return this.cachedPipelines

    const loadedFromFiles = await Promise.all(
      this.workflows.map(async (workflowPath) => await this.workflowLoader(workflowPath)),
    )
    const pipelines = [...this.pipelines, ...loadedFromFiles]
    this.cachedPipelines = pipelines.map((pipeline) => ({
      toolName: toolNameForPipeline(pipeline.id),
      pipeline,
    }))
    return this.cachedPipelines
  }

  private respond(id: number | string, result: unknown): void {
    this.transport.send({
      jsonrpc: '2.0',
      id,
      result,
    } satisfies JsonRpcResponse)
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.transport.send({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    } satisfies JsonRpcResponse)
  }
}

function toolNameForPipeline(pipelineId: string): string {
  return pipelineId.replaceAll('/', '-')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function defaultWorkflowLoader(_workflowPath: string): Promise<Pipeline> {
  throw new Error('workflowLoader is required when workflows are provided')
}
