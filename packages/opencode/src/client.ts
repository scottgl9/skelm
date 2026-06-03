// Opencode HTTP client — spawns `opencode serve --port 0` once per backend
// instance and reuses the process across multiple prompt() calls (one session
// per call, server kept alive). Disposed via dispose() when the backend is done.
//
// Improvements over the original:
//   #1 — Cleaner spawn: OPENCODE_CONFIG_CONTENT + no dead cancel()/getSessionId()
//   #2 — Model/logLevel injected via OPENCODE_CONFIG_CONTENT at server startup
//   #3 — Non-blocking promptAsync + SSE stream instead of blocking session.prompt()

import { type ChildProcess, spawn } from 'node:child_process' // @subprocess-ok: spawns opencode serve for HTTP backend
import { createOpencodeClient } from '@opencode-ai/sdk'
import type {
  AgentRequest,
  AgentResponse,
  ContentPart,
  McpServerConfig,
  ResolvedPolicy,
} from '@skelm/core'
import {
  BackendSessionError,
  BackendUnavailableError,
  RunCancelledError,
  TrustEnforcer,
  extractPromptText,
} from '@skelm/core'
import type { OpencodeBackendOptions } from './types.js'

/**
 * Map a skelm `AgentRequest.prompt` (string or `ContentPart[]`) onto
 * opencode's prompt-parts shape. Text parts become `{type:'text'}`; image
 * parts are forwarded as `{type:'file'}` with a base64 data URL, matching
 * the opencode SDK's documented `FilePartInput` schema. opencode's own
 * vision-capable models (Sonnet, GPT-4o, etc.) consume these attachments
 * directly; non-vision models surface their own provider error which
 * propagates as a thrown step failure.
 */
function buildOpencodePromptParts(
  prompt: AgentRequest['prompt'],
): Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string }> {
  if (typeof prompt === 'string') {
    return [{ type: 'text', text: prompt }]
  }
  const parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string }> =
    []
  for (const part of prompt as readonly ContentPart[]) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') {
      parts.push({
        type: 'file',
        mime: part.mimeType,
        url: `data:${part.mimeType};base64,${part.data}`,
      })
    }
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: extractPromptText(prompt) }]
}

type SdkClient = ReturnType<typeof createOpencodeClient>

// Module-singleton process-exit hook. Without this, every OpencodeClientWrapper
// that called process.once('SIGTERM', …) would add a fresh listener, tripping
// Node's MaxListeners=10 warning under any non-trivial backend churn. Wrappers
// register their child process here on spawn and unregister in dispose; the
// hook iterates the live set on signal and SIGTERMs each child.
const liveChildren = new Set<ChildProcess>()
let signalHookInstalled = false
function ensureSignalHook(): void {
  if (signalHookInstalled) return
  signalHookInstalled = true
  const cleanup = () => {
    for (const proc of liveChildren) {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* best-effort */
      }
    }
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
  process.on('exit', cleanup)
}

// Shape of OPENCODE_CONFIG_CONTENT — subset of opencode's Config type.
interface OpencodeServerConfig {
  model?: string
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  // Server-level permission defaults (apply to every session on this server).
  permission?: {
    bash?: 'allow' | 'ask' | 'deny'
    edit?: 'allow' | 'ask' | 'deny'
    webfetch?: 'allow' | 'ask' | 'deny'
  }
}

export class OpencodeClientWrapper {
  private proc: ChildProcess | null = null
  private client: SdkClient | null = null
  private startPromise: Promise<void> | null = null
  private readonly options: OpencodeBackendOptions
  // Track per-server-instance MCP attachments so we add() each one only once
  // even when the same skelm process drives many sessions through the same
  // opencode subprocess. Keyed by McpServerConfig.id.
  private readonly attachedMcp = new Set<string>()

  constructor(options: OpencodeBackendOptions) {
    this.options = options
  }

  /** Ensure the opencode server is running. Safe to call concurrently. */
  async ensureStarted(): Promise<void> {
    if (this.client !== null) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this._start()
    await this.startPromise
  }

  /** Alias kept for callers that start the server explicitly before first use. */
  async start(): Promise<void> {
    return this.ensureStarted()
  }

  private async _start(): Promise<void> {
    const command = this.options.command ?? 'opencode'

    // Inject egress proxy environment variables. Two sources, in priority:
    //   1. options.proxyEnv — per-spawn env from the runtime, with the
    //      egress token already encoded as the URL credential of HTTP_PROXY
    //      (the canonical path used by the gateway).
    //   2. options.egressProxyUrl + options.egressToken — legacy fields
    //      retained for back-compat. The token is URL-encoded here.
    const proxyEnv: Record<string, string> = {}
    if (this.options.proxyEnv !== undefined) {
      Object.assign(proxyEnv, this.options.proxyEnv)
    } else if (this.options.egressProxyUrl !== undefined) {
      proxyEnv.HTTP_PROXY = encodeProxyUrlWithToken(
        this.options.egressProxyUrl,
        this.options.egressToken,
      )
      proxyEnv.HTTPS_PROXY = proxyEnv.HTTP_PROXY
      if (this.options.egressToken !== undefined) {
        proxyEnv.SKELM_EGRESS_TOKEN = this.options.egressToken
      }
    }

    // (#2) Inject model and logLevel via OPENCODE_CONFIG_CONTENT so opencode
    // uses them as its defaults for every session, without needing per-session
    // body overrides.
    const serverConfig: OpencodeServerConfig = {}
    if (this.options.model) serverConfig.model = this.options.model
    if (this.options.logLevel && this.options.logLevel !== 'off') {
      const logLevelMap = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' } as const
      serverConfig.logLevel = logLevelMap[this.options.logLevel]
    }
    if (this.options.serverPermissions) {
      serverConfig.permission = this.options.serverPermissions
    }

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(command, ['serve', '--port', '0'], {
        env: { ...process.env, ...proxyEnv, OPENCODE_CONFIG_CONTENT: JSON.stringify(serverConfig) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.proc = proc
      // Register against the module-singleton SIGTERM/SIGINT/exit hook so the
      // opencode child gets killed when the node parent is signalled (CLI
      // timeout, Ctrl-C, gateway shutdown). Without this, the child is
      // reparented to PID 1 and lingers as an orphan.
      liveChildren.add(proc)
      ensureSignalHook()

      let resolved = false
      let stdoutBuf = ''
      const MAX_BUF_BYTES = 64 * 1024
      // opencode prints its listen URL on stdout. Parse stdout only and
      // anchor strictly to a loopback URL so noisy stderr (or LLM output
      // proxied through stderr) cannot redirect the gateway to an
      // attacker-controlled URL. The buffer is capped so a flood of
      // non-matching output can't be retained indefinitely.
      const LISTEN_RE =
        /(?:^|\n)opencode(?: \w+)? listening on (https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+)(?=\s|$)/

      const tryParseStdout = (chunk: Buffer) => {
        if (resolved) return
        stdoutBuf += chunk.toString('utf8')
        if (stdoutBuf.length > MAX_BUF_BYTES) {
          stdoutBuf = stdoutBuf.slice(stdoutBuf.length - MAX_BUF_BYTES)
        }
        const m = stdoutBuf.match(LISTEN_RE)
        if (m?.[1]) {
          resolved = true
          this.client = createOpencodeClient({ baseUrl: m[1].trim() })
          resolve()
        }
      }

      proc.stdout?.on('data', tryParseStdout)
      // stderr is consumed only to drain the pipe and avoid backpressure;
      // its content is no longer parsed for the listen URL.
      proc.stderr?.on('data', () => {})
      proc.once('error', (err) => {
        if (!resolved) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'EACCES') {
            reject(
              new BackendUnavailableError(
                `opencode backend is not available: command "${command}" was not found or is not executable`,
                this.options.id ?? 'opencode',
              ),
            )
            return
          }
          reject(err)
        } else this._handleExit()
      })
      proc.once('exit', () => {
        if (!resolved) reject(new Error('opencode serve exited before becoming ready'))
        else this._handleExit()
      })
      setTimeout(() => {
        if (!resolved) reject(new Error('opencode serve: timed out waiting for port'))
      }, 15_000)
    })
  }

  private _handleExit(): void {
    if (this.proc !== null) liveChildren.delete(this.proc)
    this.proc = null
    this.client = null
    this.startPromise = null
    this.attachedMcp.clear()
  }

  async prompt(
    request: AgentRequest,
    signal: AbortSignal,
    timeoutMs = 300_000,
    resolvedPolicy?: ResolvedPolicy,
    onPartial?: (delta: string) => void,
  ): Promise<AgentResponse> {
    await this.ensureStarted()
    if (!this.client) throw new BackendSessionError('opencode serve not ready', 'opencode')

    const cwd = request.cwd ?? process.cwd()

    // Forward each per-step McpServerConfig to opencode so its model sees the
    // namespaced tools. The opencode subprocess persists across calls, so the
    // mcp.add() endpoint is idempotent per (serverId, this wrapper) — we only
    // call it once per ID per opencode subprocess.
    if (request.mcpServers !== undefined && request.mcpServers.length > 0) {
      await this._attachMcpServers(request.mcpServers)
    }

    const sessResult = await this.client.session.create({ query: { directory: cwd } })
    if (!sessResult.data) {
      throw new BackendSessionError(
        `session.create failed: ${JSON.stringify(sessResult.error)}`,
        'opencode',
        { cause: sessResult.error },
      )
    }
    const sessionId = sessResult.data.id

    // (#3) Subscribe to the global SSE stream BEFORE calling promptAsync so
    // we don't miss events that fire immediately after the session starts.
    const sseAbort = new AbortController()
    const timeoutId = setTimeout(
      () => sseAbort.abort(new Error(`opencode timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    const onSignalAbort = () => sseAbort.abort(new Error('opencode aborted'))
    signal.addEventListener('abort', onSignalAbort, { once: true })

    try {
      const { stream } = await this.client.event.subscribe({ signal: sseAbort.signal })

      // (#3) Fire promptAsync — returns immediately; response arrives over SSE.
      // Model is already set via OPENCODE_CONFIG_CONTENT (#2), so no per-request body needed.
      const promptResult = await this.client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: buildOpencodePromptParts(request.prompt),
          ...(request.system !== undefined && { system: request.system }),
          ...(resolvedPolicy !== undefined && {
            tools: buildOpencodeToolsFromPolicy(resolvedPolicy),
          }),
        },
      })
      if (!promptResult.data) {
        throw new BackendSessionError(
          `session.promptAsync failed: ${JSON.stringify(promptResult.error)}`,
          'opencode',
          { cause: promptResult.error },
        )
      }

      return await this._collectFromStream(stream, sessionId, signal, onPartial, resolvedPolicy)
    } finally {
      clearTimeout(timeoutId)
      signal.removeEventListener('abort', onSignalAbort)
      sseAbort.abort() // close SSE connection
      // Best-effort abort of the session if we're bailing out early
      if (signal.aborted) {
        this.client?.session.abort({ path: { id: sessionId } }).catch(() => {})
      }
    }
  }

  // (#3) Collect text from SSE events for one session until it goes idle.
  private async _collectFromStream(
    stream: AsyncIterable<unknown>,
    sessionId: string,
    signal: AbortSignal,
    onPartial?: (delta: string) => void,
    resolvedPolicy?: ResolvedPolicy,
  ): Promise<AgentResponse> {
    // Only collect text parts from assistant messages; track which message IDs are assistant.
    const assistantMessageIds = new Set<string>()
    // Each TextPart is updated incrementally; track the latest full text per part id.
    const textParts = new Map<string, string>()

    for await (const raw of stream) {
      if (signal.aborted) break

      const event = raw as { type: string; properties: Record<string, unknown> }

      if (event.type === 'session.error') {
        const props = event.properties as { sessionID?: string; error?: unknown }
        if (!props.sessionID || props.sessionID === sessionId) {
          throw new BackendSessionError(
            `opencode session error: ${JSON.stringify(props.error)}`,
            'opencode',
            { cause: props.error },
          )
        }
      }

      // Opencode pauses the session and emits permission.asked when a tool
      // wants to escalate (external_directory read/write, bash, etc.). The
      // session stays paused until we POST a response — without this handler
      // _collectFromStream blocks forever waiting for session.idle.
      if (event.type === 'permission.asked') {
        const props = event.properties as {
          sessionID?: string
          id?: string
          permission?: string
          patterns?: string[]
          metadata?: { filepath?: string }
        }
        if (props.sessionID === sessionId && typeof props.id === 'string') {
          const response = this._decidePermission(
            props.permission ?? '',
            props.metadata?.filepath,
            props.patterns,
            resolvedPolicy,
          )
          await this.client
            ?.postSessionIdPermissionsPermissionId({
              path: { id: sessionId, permissionID: props.id },
              body: { response },
            })
            .catch(() => {
              /* opencode will give up on its own; we'll exit on session.idle/error */
            })
        }
      }

      if (event.type === 'message.updated') {
        const props = event.properties as {
          info: { id: string; sessionID: string; role: string }
        }
        if (props.info.sessionID === sessionId && props.info.role === 'assistant') {
          assistantMessageIds.add(props.info.id)
        }
      }

      if (event.type === 'message.part.updated') {
        const props = event.properties as {
          part: {
            type: string
            sessionID: string
            messageID: string
            id: string
            text?: string
            synthetic?: boolean
          }
        }
        const { part } = props
        if (
          part.sessionID === sessionId &&
          assistantMessageIds.has(part.messageID) &&
          part.type === 'text' &&
          !part.synthetic &&
          part.text
        ) {
          const prev = textParts.get(part.id) ?? ''
          const next = part.text as string
          // Emit the delta (new characters since last update for this part)
          if (onPartial !== undefined && next.length > prev.length) {
            onPartial(next.slice(prev.length))
          }
          textParts.set(part.id, next)
        }
      }

      if (event.type === 'session.idle') {
        const props = event.properties as { sessionID: string }
        if (props.sessionID === sessionId) break
      }
    }

    if (signal.aborted) throw new RunCancelledError()

    const text = [...textParts.values()].join('')
    return { text: text.trim(), stopReason: 'end_turn' }
  }

  // Map a skelm McpServerConfig (stdio variant) to opencode's local MCP config
  // and POST it to /mcp. Remote (http/sse) transports are not yet supported by
  // this bridge — opencode's McpRemoteConfig has a different shape and isn't
  // exercised by the §21 fixtures; we surface a clear error rather than a
  // silent drop so a future fixture catches it.
  private async _attachMcpServers(servers: readonly McpServerConfig[]): Promise<void> {
    if (this.client === null) return
    for (const server of servers) {
      if (this.attachedMcp.has(server.id)) continue
      if (server.transport !== 'stdio') {
        throw new BackendSessionError(
          `opencode backend currently only forwards stdio MCP servers; "${server.id}" uses ${server.transport}`,
          'opencode',
        )
      }
      const command = [server.command, ...(server.args ?? [])]
      const result = await this.client.mcp.add({
        body: {
          name: server.id,
          config: {
            type: 'local',
            command,
            enabled: true,
            ...(server.env !== undefined && { environment: { ...server.env } }),
          },
        },
      })
      if (result.error !== undefined) {
        throw new BackendSessionError(
          `opencode mcp.add(${server.id}) failed: ${JSON.stringify(result.error)}`,
          'opencode',
          { cause: result.error },
        )
      }
      this.attachedMcp.add(server.id)
    }
  }

  // Translate an opencode permission.asked into a once/reject decision using
  // the step's ResolvedPolicy. "external_directory" is the common case (the
  // model wants to read/write outside the session's directory); we accept if
  // the path falls within fsRead or fsWrite. Everything else defaults to
  // reject — opencode's prompt that asked will report the denial back to the
  // model and the loop continues.
  private _decidePermission(
    permission: string,
    filepath: string | undefined,
    _patterns: string[] | undefined,
    policy: ResolvedPolicy | undefined,
  ): 'once' | 'reject' {
    if (policy === undefined) return 'reject'
    if (permission === 'external_directory' && filepath !== undefined) {
      const enf = new TrustEnforcer(policy)
      if (enf.canRead(filepath).allow) return 'once'
      if (enf.canWrite(filepath).allow) return 'once'
    }
    return 'reject'
  }

  async dispose(): Promise<void> {
    this.proc?.kill('SIGTERM')
    this._handleExit()
  }
}

/**
 * Encode an egress token into the credential field of a proxy URL so that
 * standard HTTP clients automatically send `Proxy-Authorization: Basic
 * <base64(token:<egressToken>)>`. The token (and the literal "token"
 * username) are URL-encoded for safety.
 *
 * Exported for testing.
 */
export function encodeProxyUrlWithToken(proxyUrl: string, token: string | undefined): string {
  if (token === undefined || token === '') return proxyUrl
  try {
    const url = new URL(proxyUrl)
    url.username = 'token'
    url.password = token
    return url.toString()
  } catch {
    return proxyUrl
  }
}

// Map a skelm ResolvedPolicy to opencode's per-prompt tool allow/deny map.
// opencode tool names: bash, read, edit, glob, grep, list, webSearch.
function buildOpencodeToolsFromPolicy(policy: ResolvedPolicy): Record<string, boolean> {
  // star = all tools allowed; return empty map to let opencode use its defaults.
  if (policy.allowedTools.star) return {}

  const allow = (name: string) =>
    policy.allowedTools.exact.has(name) ||
    policy.allowedTools.prefixes.some((p) => name.startsWith(p))

  return {
    bash: policy.allowedExecutables.size > 0 || allow('bash'),
    read: policy.fsRead.size > 0 || allow('read'),
    edit: policy.fsWrite.size > 0 || allow('edit'),
    glob: policy.fsRead.size > 0 || allow('glob'),
    grep: policy.fsRead.size > 0 || allow('grep'),
    list: policy.fsRead.size > 0 || allow('list'),
    webSearch: policy.networkEgress !== 'deny' || allow('webSearch'),
  }
}
