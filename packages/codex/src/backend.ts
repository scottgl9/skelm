import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSystemPromptFromRequest,
  extractPromptText,
  loadSkillBodies,
  resolvePermissions,
} from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  ContentPart,
  McpServerConfig,
  ResolvedPolicy,
  SkelmBackend,
} from '@skelm/core'

import {
  buildCodexOptions,
  buildMcpServerConfig,
  buildThreadOptions,
  consumeStream,
  makeCodexClient,
} from './client.js'
import { mapPermissionsToCodex } from './permission-mapper.js'
import type { CodexBackendOptions } from './types.js'

/**
 * SkelmBackend for OpenAI Codex via the official `@openai/codex-sdk`.
 *
 * Surfaces the full skelm feature set against Codex:
 *
 *   - MCP servers injected through `CodexOptions.config.mcp_servers`.
 *   - Skills concatenated into the system prompt before each turn.
 *   - Permissions translated to Codex sandbox + approval modes.
 *   - Streaming events relayed via `BackendContext.onPartial`.
 *   - Session resumption via `Codex.resumeThread`.
 *   - Cancellation via the SDK's per-turn `signal: AbortSignal`.
 *
 * Permission enforcement is `'native'`: Codex enforces sandbox / approval /
 * network natively in its own process. Skelm validates at the boundary
 * (pre-run refusal, workspace pinning, egress proxy envelope, post-event
 * audit) — never widening what the policy permits.
 */
export function createCodexBackend(options: CodexBackendOptions = {}): SkelmBackend {
  const capabilities: BackendCapabilities = {
    prompt: false,
    streaming: true,
    sessionLifecycle: true,
    mcp: true,
    skills: true,
    modelSelection: options.model !== undefined,
    // Codex enforces sandbox / approval / network natively in its own process.
    // Skelm checks at the boundary (refusing unsafe combinations before any
    // Codex call); Codex enforces at runtime.
    toolPermissions: 'native',
    // Image content is forwarded as `{type:'local_image', path}` per the
    // codex-sdk schema; bytes are materialized to a temp file for the turn
    // and cleaned up afterwards. Whether the configured codex model can
    // actually process images is up to the model — non-vision models will
    // surface a provider error that propagates as a step failure.
    vision: options.vision ?? true,
  }

  const backend: SkelmBackend = {
    id: options.id ?? 'codex',
    capabilities,
    ...(options.label !== undefined && { label: options.label }),

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      // When neither the request nor the context carries a resolved policy,
      // synthesize an empty-deny ResolvedPolicy from `resolvePermissions(
      // undefined, undefined)`. This matches the documented default-deny
      // intent of skelm: an omitted policy must deny everything, not crash
      // the run. Previously we threw "codex backend requires a resolved
      // permission policy" here, which forced every codex agent() step to
      // restate the same empty allowlists even when config-level defaults
      // were set. The mapper below still translates this into Codex's
      // strictest sandbox/approval/network settings.
      const policy: ResolvedPolicy =
        request.permissions ?? context.permissions ?? resolvePermissions(undefined, undefined)

      // Boundary check + sandbox/approval translation. Throws on refusal.
      const mapped = mapPermissionsToCodex({
        policy,
        ...(request.cwd !== undefined && { workingDirectory: request.cwd }),
      })

      // Filter requested MCP servers through the allowlist.
      const allowed = filterAllowedMcp(request.mcpServers, policy.allowedMcpServers)
      const mcpConfig = buildMcpServerConfig(allowed.allowed)
      const deniedMcp = allowed.denied.map((s) => s.id)
      // Audit-only for now; the runner's audit writer is the durable record.
      const logDenial = (dimension: string, ids: string[], reason: string) =>
        console.warn(
          JSON.stringify({ event: 'permission.denied', dimension, ids, reason, backend: 'codex' }),
        )
      if (deniedMcp.length > 0) {
        logDenial('mcp', deniedMcp, 'not-in-allowlist')
      }
      if (mcpConfig !== null && mcpConfig.dropped.length > 0) {
        logDenial('mcp', mcpConfig.dropped, 'transport-unsupported')
      }

      // Construct the SDK client with config + proxy env. Only forward
      // `mcp_servers` to Codex — never leak the `dropped` bookkeeping field.
      const codexOpts = buildCodexOptions(options, {
        ...(context.proxyEnv !== undefined && { env: context.proxyEnv }),
        ...(mcpConfig !== null && { config: { mcp_servers: mcpConfig.mcp_servers } }),
      })
      const codex = makeCodexClient(codexOpts)

      // Compose the system prompt via @skelm/core's shared builder so
      // systemPromptMode / systemPromptIncludeAgentDef take effect here.
      const systemPrompt = await composeSystemPrompt(request, context, options.model)
      // Codex SDK accepts string OR Array<{type:'text'}|{type:'local_image',path}>.
      // For image-bearing prompts we materialize each image to a temp file
      // (Codex requires filesystem paths, not data URLs) and clean up after
      // the turn. Pure-text prompts keep the prior compact "<system>\n\n---\n\n<text>" shape.
      const imageRoots: string[] = []
      const userPrompt:
        | string
        | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> =
        typeof request.prompt === 'string' || extractImageParts(request.prompt).length === 0
          ? (() => {
              const promptText = extractPromptText(request.prompt)
              return systemPrompt === undefined
                ? promptText
                : `${systemPrompt}\n\n---\n\n${promptText}`
            })()
          : buildCodexMultimodalInput(request.prompt, systemPrompt, imageRoots)

      // Build the thread (resume vs fresh) honoring per-step sandbox/approval.
      const threadOpts = buildThreadOptions(options, {
        sandboxMode: mapped.sandboxMode,
        approvalPolicy: mapped.approvalPolicy,
        networkAccessEnabled: mapped.networkAccessEnabled,
        webSearchEnabled: mapped.webSearchEnabled,
        webSearchMode: mapped.webSearchMode,
        ...(mapped.workingDirectory !== undefined && {
          workingDirectory: mapped.workingDirectory,
        }),
        ...(mapped.additionalDirectories !== undefined && {
          additionalDirectories: mapped.additionalDirectories,
        }),
      })

      const sessionId = readSessionId(request)
      const thread =
        sessionId !== undefined
          ? codex.resumeThread(sessionId, threadOpts)
          : codex.startThread(threadOpts)

      // Compose abort: the runner-supplied `context.signal` AND the
      // backend's `timeoutMs` (defensive ceiling). The SDK honors a single
      // AbortSignal on TurnOptions natively.
      const turnSignal = composeAbortSignal(context.signal, options.timeoutMs ?? 300_000)
      const { events } = await thread.runStreamed(userPrompt, {
        ...(request.outputSchema !== undefined && { outputSchema: request.outputSchema }),
        signal: turnSignal.signal,
      })

      let result: Awaited<ReturnType<typeof consumeStream>>
      try {
        result = await consumeStream(events, {
          ...(context.onPartial !== undefined && { onText: context.onPartial }),
        })
      } finally {
        turnSignal.cancel()
        cleanupTempImageRoots(imageRoots)
      }

      const response: AgentResponse = {
        text: result.finalText,
        stopReason: result.stopReason,
      }
      if (result.usage !== undefined) {
        response.usage = {
          ...(result.usage.inputTokens !== undefined && { inputTokens: result.usage.inputTokens }),
          ...(result.usage.outputTokens !== undefined && {
            outputTokens: result.usage.outputTokens,
          }),
          ...(result.usage.reasoningTokens !== undefined && {
            reasoningTokens: result.usage.reasoningTokens,
          }),
        }
      }
      return response
    },
  }

  return backend
}

function extractImageParts(
  prompt: AgentRequest['prompt'],
): ReadonlyArray<Extract<ContentPart, { type: 'image' }>> {
  if (typeof prompt === 'string') return []
  return (prompt as readonly ContentPart[]).filter(
    (p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image',
  )
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    default:
      return '.bin'
  }
}

function buildCodexMultimodalInput(
  prompt: readonly ContentPart[] | string,
  systemPrompt: string | undefined,
  imageRoots: string[],
): Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> {
  const tmp = mkdtempSync(join(tmpdir(), 'skelm-codex-img-'))
  imageRoots.push(tmp)
  const parts: Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> = []
  let imgIdx = 0
  // Seed the text buffer with the system prompt block so it always lands as
  // the FIRST text part — even when the prompt is `[image, text, ...]` and we
  // would otherwise flush a `local_image` before seeing any user text.
  // Mirrors the pure-text fallback `"<system>\n\n---\n\n<text>"` higher up,
  // so callers see consistent ordering regardless of which path the request
  // takes.
  let textBuf = systemPrompt !== undefined ? `${systemPrompt}\n\n---\n\n` : ''
  if (typeof prompt === 'string') {
    parts.push({ type: 'text', text: `${textBuf}${prompt}` })
    return parts
  }
  for (const part of prompt) {
    if (part.type === 'text') {
      textBuf += part.text
    } else if (part.type === 'image') {
      if (textBuf.length > 0) {
        parts.push({ type: 'text', text: textBuf })
        textBuf = ''
      }
      const file = join(tmp, `img${imgIdx++}${mimeToExt(part.mimeType)}`)
      try {
        writeFileSync(file, Buffer.from(part.data, 'base64'))
      } catch (err) {
        throw new Error(
          `codex backend: failed to materialize image to ${file}: ${(err as Error).message}`,
          { cause: err },
        )
      }
      parts.push({ type: 'local_image', path: file })
    }
  }
  if (textBuf.length > 0) parts.push({ type: 'text', text: textBuf })
  return parts
}

function cleanupTempImageRoots(roots: readonly string[]): void {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup; OS will eventually reap /tmp anyway.
    }
  }
}

function filterAllowedMcp(
  servers: readonly McpServerConfig[] | undefined,
  allowlist: ReadonlySet<string>,
): { allowed: McpServerConfig[]; denied: McpServerConfig[] } {
  if (servers === undefined || servers.length === 0) return { allowed: [], denied: [] }
  const allowed: McpServerConfig[] = []
  const denied: McpServerConfig[] = []
  for (const s of servers) {
    if (allowlist.has(s.id)) allowed.push(s)
    else denied.push(s)
  }
  return { allowed, denied }
}

async function composeSystemPrompt(
  req: AgentRequest,
  ctx: BackendContext,
  model: string | undefined,
): Promise<string | undefined> {
  // Route through @skelm/core's shared builder so `systemPromptMode` and
  // `systemPromptIncludeAgentDef` actually take effect on codex. Without
  // this, codex previously hand-rolled the prompt out of soul +
  // instructions + system + skills, ignoring both flags — the same input
  // produced identical token counts in extend vs replace mode.
  //
  // The builder owns the "extend" vs "replace" composition and the
  // "include AGENTS.md/SOUL.md when replacing" carve-out. We pass an
  // empty tool list because codex enforces its tool surface natively and
  // skelm doesn't dispatch tools through this backend — there's no
  // skelm-side tool inventory worth injecting.
  const base = buildSystemPromptFromRequest(req, {
    cwd: req.cwd ?? process.cwd(),
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
    ...(model !== undefined && { model }),
    tools: [],
  })
  const skillBodies = await loadSkillBodies(req, ctx)
  const parts: string[] = []
  if (base.length > 0) parts.push(base)
  parts.push(...skillBodies)
  if (parts.length === 0) return undefined
  return parts.join('\n\n---\n\n')
}

/**
 * AgentRequest doesn't have a typed sessionId field at the moment, but
 * runners may attach one through structural typing. Read defensively.
 * TODO(@skelm/core): promote `sessionId?: string` to AgentRequest so this
 * cast goes away.
 */
function readSessionId(request: AgentRequest): string | undefined {
  const sid = (request as { sessionId?: unknown }).sessionId
  return typeof sid === 'string' && sid.length > 0 ? sid : undefined
}

/**
 * Compose the runner's signal with a backend-side timeout. The returned
 * signal aborts when either fires; `cancel()` clears the timer so a
 * successful run doesn't leak it.
 */
function composeAbortSignal(
  upstream: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  if (upstream.aborted) controller.abort(upstream.reason)
  const onAbort = () => controller.abort(upstream.reason)
  upstream.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new Error(`codex backend timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      upstream.removeEventListener('abort', onAbort)
    },
  }
}
