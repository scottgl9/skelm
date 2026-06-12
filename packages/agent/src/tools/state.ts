/**
 * Run-state and artifact tool contracts for the native agent.
 *
 * These tools let the agent read/write durable run state and persist
 * artifacts through handles supplied on the ToolExecutionContext. The
 * BackendContext does NOT yet expose state/artifact handles, so today these
 * handles are always undefined at runtime and the tools refuse with an
 * actionable "not wired" message. The contract is defined here so that when the
 * runtime grows `state` / `artifacts` on BackendContext, wiring is a one-line
 * forward in backend.ts with no tool changes.
 *
 * No new permission dimension is introduced: presence of the handle IS the
 * grant (default-deny — absent handle means the operation is denied). The
 * runtime/gateway is the trust boundary that decides whether to hand a step a
 * state or artifact handle.
 */

import type { BuiltInToolDef, ToolResult } from '../tools.js'

/** Minimal typed surface for reading/writing durable run state. */
export interface StateHandle {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  keys(): Promise<readonly string[]>
}

/** Minimal typed surface for persisting run artifacts. */
export interface ArtifactHandle {
  /** Persist an artifact and return a stable reference id. */
  put(input: {
    name: string
    content: string
    contentType?: string
    encoding?: 'utf-8' | 'base64'
  }): Promise<{ id: string }>
  /** List artifact references already persisted for this run. */
  list(): Promise<readonly { id: string; name: string }[]>
}

const STATE_NOT_WIRED =
  'State is not available for this run (no state handle is wired into the agent step). ' +
  'This tool is contract-defined and activates once the runtime exposes a state handle on the backend context.'

const ARTIFACT_NOT_WIRED =
  'Artifacts are not available for this run (no artifact handle is wired into the agent step). ' +
  'This tool is contract-defined and activates once the runtime exposes an artifact handle on the backend context.'

export const STATE_TOOLS: readonly BuiltInToolDef[] = [
  {
    name: 'state_get',
    description:
      'Read a value from durable run state by key. Returns the JSON-encoded value, ' +
      'or a not-found note when the key is absent.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'State key to read.' } },
      required: ['key'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { key?: string }
      if (!p.key) return { content: 'Error: key is required', isError: true }
      if (ctx.state === undefined) return { content: STATE_NOT_WIRED, isError: true }
      const value = await ctx.state.get(p.key)
      if (value === undefined) return { content: `State key "${p.key}" not found` }
      return { content: JSON.stringify(value) }
    },
  },
  {
    name: 'state_set',
    description: 'Write a JSON value into durable run state under a key.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'State key to write.' },
        value: { description: 'Any JSON value to store.' },
      },
      required: ['key', 'value'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { key?: string; value?: unknown }
      if (!p.key) return { content: 'Error: key is required', isError: true }
      if (ctx.state === undefined) return { content: STATE_NOT_WIRED, isError: true }
      await ctx.state.set(p.key, p.value)
      return { content: `State key "${p.key}" set` }
    },
  },
  {
    name: 'artifact_put',
    description:
      'Persist an artifact (text or base64) for this run and get back a stable reference id.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable artifact name.' },
        content: { type: 'string', description: 'Artifact body.' },
        contentType: { type: 'string', description: 'Optional MIME type.' },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description: 'Body encoding (default utf-8).',
        },
      },
      required: ['name', 'content'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as {
        name?: string
        content?: string
        contentType?: string
        encoding?: 'utf-8' | 'base64'
      }
      if (!p.name || p.content === undefined) {
        return { content: 'Error: name and content are required', isError: true }
      }
      if (ctx.artifacts === undefined) return { content: ARTIFACT_NOT_WIRED, isError: true }
      const ref = await ctx.artifacts.put({
        name: p.name,
        content: p.content,
        ...(p.contentType !== undefined && { contentType: p.contentType }),
        ...(p.encoding !== undefined && { encoding: p.encoding }),
      })
      return { content: JSON.stringify(ref) }
    },
  },
]
