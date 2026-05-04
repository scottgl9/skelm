# ACP sessions

Resident ACP agents (declared with `lifecycle: 'resident'` and `runtime: 'acp'` or similar) hold long-lived conversations the gateway tracks as **sessions**. Sessions persist to disk so they survive gateway restarts; the supervisor reconciles them at startup.

Ephemeral agents do **not** use the session manager — their per-invocation handle dies with the process. There is no session to persist.

## Session shape

```ts
interface AcpSession {
  id: string                    // gateway-assigned UUID
  agentId: string               // registry id (e.g. 'opencode-1')
  createdAt: string             // ISO-8601
  lastSeenAt: string            // updated on every touch / resume
  state: 'active' | 'paused' | 'expired'
  metadata: Readonly<Record<string, unknown>>  // free-form, e.g. agent-side handle
}
```

Persisted as JSON to `<stateDir>/acp-sessions.json`.

## Lifecycle

```
create  → active
touch   → updates lastSeenAt
resume  → active (refuses if expired)
terminate → removed
reconcile (on gateway start) → expires sessions older than expireAfterMs
```

`expireAfterMs` defaults to undefined (sessions never expire automatically). When set, `reconcile()` flips stale sessions to `expired` and `resume()` returns `undefined` for them — the agent has to be re-seeded with a fresh session.

## CLI (Phase 11)

```bash
skelm sessions list
skelm sessions get <id>
skelm sessions resume <id>
skelm sessions stop <id>
```

The CLI talks to the running gateway over HTTP. The Phase 11 control surface adds:

```
POST /agents/:id/sessions
GET  /sessions
GET  /sessions/:id
POST /sessions/:id/resume
DELETE /sessions/:id
```

## Audit

Every lifecycle event is appended to the audit chain:

- `acp.session.create   { sessionId, agentId }`
- `acp.session.touch    { sessionId }`
- `acp.session.resume   { sessionId }`
- `acp.session.terminate { sessionId }`
- `acp.session.expire   { sessionId, lastSeenAt }`

## Status

Phase 9 lands the manager + persistence + reconcile semantics. Phase 11 wires the HTTP surface and CLI.
