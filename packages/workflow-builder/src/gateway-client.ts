// Gateway-backed implementations of ApplyRoute and ValidateRunner. These are
// the runtime wiring used by the persistent entrypoint: every privileged action
// (deriving a graph, applying source edits, validating a candidate) is an
// authenticated call to the gateway, which owns enforcement, validation, and
// the single audit writer. The builder library itself stays I/O-free and
// subprocess-free; this module is the only place that talks to the gateway.

import type { GraphEdit, WorkflowGraph } from '@skelm/core'
import type { ApplyRoute, ReviewablePatch, ValidateRunner, ValidationOutcome } from './types.js'

export interface GatewayClientOptions {
  /** Gateway base URL, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string
  /** Bearer token for the gateway control plane. */
  token: string
  /** Injectable fetch (defaults to global). */
  fetch?: typeof globalThis.fetch
}

export function createGatewayApplyRoute(options: GatewayClientOptions): ApplyRoute {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const base = options.baseUrl.replace(/\/+$/, '')
  const headers = {
    authorization: `Bearer ${options.token}`,
    'content-type': 'application/json',
  }
  return {
    async deriveGraph(workflowId) {
      const res = await fetchImpl(`${base}/v1/workflows/${encodeURIComponent(workflowId)}/graph`, {
        headers: { authorization: headers.authorization },
      })
      if (!res.ok) {
        throw new Error(`gateway graph request failed: ${res.status} ${await safeText(res)}`)
      }
      return (await res.json()) as WorkflowGraph
    },
    async applyEdits(workflowId, edits: readonly GraphEdit[], opts) {
      // Default-safe: only an explicit dryRun: false ever writes.
      const dryRun = opts?.dryRun !== false
      const res = await fetchImpl(
        `${base}/v1/workflows/${encodeURIComponent(workflowId)}/source/apply`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ edits, dryRun }),
        },
      )
      if (res.status === 422) {
        const data = (await res.json().catch(() => ({}))) as {
          reason?: ReviewablePatch['reason']
          detail?: string
          message?: string
        }
        return {
          ok: false,
          applied: false,
          dryRun,
          ...(data.reason !== undefined && { reason: data.reason }),
          detail: data.detail ?? data.message ?? 'apply refused',
        }
      }
      if (!res.ok) {
        throw new Error(`gateway apply request failed: ${res.status} ${await safeText(res)}`)
      }
      const body = (await res.json()) as {
        ok: boolean
        applied?: boolean
        dryRun?: boolean
        diff?: string
        revision?: string
      }
      return {
        ok: body.ok,
        applied: body.applied ?? false,
        dryRun: body.dryRun ?? dryRun,
        ...(body.diff !== undefined && { diff: body.diff }),
        ...(body.revision !== undefined && { revision: body.revision }),
      }
    },
  }
}

/**
 * A ValidateRunner that calls the gateway's `POST /v1/workflows/validate`
 * route. Keeping validation on the gateway means the builder package ships no
 * subprocess and no in-process workflow loader; the gateway is the execution
 * surface.
 */
export function createGatewayValidateRunner(options: GatewayClientOptions): ValidateRunner {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const base = options.baseUrl.replace(/\/+$/, '')
  return async (sourcePath: string): Promise<ValidationOutcome> => {
    const res = await fetchImpl(`${base}/v1/workflows/validate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ source: sourcePath }),
    })
    const text = await safeText(res)
    return {
      valid: res.ok,
      stdout: res.ok ? text : '',
      stderr: res.ok ? '' : text,
      exitCode: res.ok ? 0 : 1,
    }
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
