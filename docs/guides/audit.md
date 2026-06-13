# Audit log

The gateway writes a single, append-only, hash-chained audit log. One process per gateway instance owns it; the gateway lockfile (`gateway.lock`) doubles as the audit-writer claim.

## Where it lives

```
~/.skelm/audit.jsonl     # one line per entry, JSON
```

Override the directory via the `--state-dir` flag or `SKELM_STATE_DIR` env var.

## Entry shape

Every entry is a JSON object with these fields:

| Field | Source | Notes |
|------|--------|------|
| `seq` | writer | 1-based monotonic sequence number. |
| `timestamp` | writer | ISO-8601, UTC. |
| `runId` | caller | Optional run identifier. |
| `actor` | caller | Who took the action — `gateway`, `cli`, `runner`, `<agent-id>`. |
| `action` | caller | Dotted name — e.g. `gateway.start`, `permission.deny`, `secret.resolve`. |
| `details` | caller | Free-form structured context. **Never include secret values.** |
| `prevHash` | writer | Hex SHA-256 of the previous entry's `entryHash`, or all-zero for seq 1. |
| `entryHash` | writer | Hex SHA-256 over a canonical JSON encoding of the entry sans `entryHash`. |

## What gets audited

Coverage at v1:

- Gateway lifecycle: `gateway.start`, `gateway.stop`, `gateway.reload`, `gateway.plugin.load`.
- Permission decisions: `permission.deny`.
- Secret access: `secret.resolve` — name only, never value.
- Approvals: `approval.request`, `approval.approve`, `approval.deny`.
- Agent + session lifecycle: `agent.spawn`, `agent.exit`, `acp.session.create`.
- CLI overrides: `cli.allow.override`.

Retention is intentional — default is forever. Configuring shorter retention is itself an audited operation.

## CLI

```bash
skelm audit query                       # all entries, newest first
skelm audit query --run <runId>
skelm audit query --actor gateway --action gateway.start
skelm audit query --since 2026-05-01T00:00:00Z --until 2026-05-02
skelm audit query --limit 50 --json
skelm audit query --verify              # walks the chain end-to-end
```

`--verify` returns a non-zero exit code and the breach details if it finds an out-of-order seq, a broken `prevHash`, or a tampered entry.

## Export

`skelm audit export` streams the filtered log to stdout or a file for archival,
ingestion, or offline analysis. It honors the same filters as `query` but has
**no tail limit** — it is the full filtered history — and is streamed
line-by-line off the chain so memory stays bounded regardless of log size.

```bash
skelm audit export                                   # JSONL to stdout
skelm audit export --format csv --out audit.csv      # CSV to a file
skelm audit export --since 2026-05-01 --action permission.deny
```

- `--format jsonl` (default) emits one JSON object per line.
- `--format csv` emits a header row then one row per entry, with a stable column
  order (`seq,timestamp,actor,action,runId,prevHash,entryHash,details`) and
  RFC-4180 escaping. The `details` cell is the JSON-encoded `details` object.
- No export column ever contains a secret value — audit rows record the *fact*
  of access (a secret name), never the value.

The backing HTTP route is `GET /v1/audit/export`.

## Retention and pruning

Default retention is forever. To bound disk growth, `skelm audit prune` archives
the head of the log and keeps a verifiable tail:

```bash
skelm audit prune --before <seq> --confirm
```

Pruning moves every entry with `seq <= before` into a sibling archive segment
(`audit.jsonl.archive.<timestamp>.jsonl`), rewrites the live log to the retained
tail, and records a boundary file (`audit.jsonl.prune-boundary.json`).

**Chain-verify implication.** The hash chain is a single end-to-end structure:
entry 1 chains from an all-zero `prevHash`, and every later entry chains from its
predecessor. Removing the head therefore breaks a full-chain `verify()` — the
retained tail no longer starts at seq 1. Pruning is destructive *by design* and
refuses without `--confirm`. To keep both halves verifiable:

- The **archived segment** is a genesis-rooted chain and verifies on its own.
- The **retained tail** verifies against the recorded boundary: the boundary
  stores the last archived entry's `entryHash` and `prunedThroughSeq`, so the
  tail's first entry is checked against that hash instead of the genesis zero.

Keep the archive segments and the boundary file together with the live log if
you need to prove continuous coverage across a prune. Each prune is itself
audited (`audit.pruned`).

## SIEM / log streaming

The gateway can stream every audit record to an external sink (a SIEM, a log
collector, a webhook) as it is written. This is a **read-side tee over the
single audit writer**, not a second audit writer: the canonical hash-chained
write happens first and is authoritative, and the same record is then forwarded.

Configure it in `skelm.gateway.ts`:

```ts
import { defineGatewayConfig } from 'skelm'

export default defineGatewayConfig({
  auditForwarding: {
    enabled: true,
    sinks: [
      // Generic HTTP/webhook sink — POSTs each record as a JSON body.
      {
        kind: 'http',
        url: 'https://siem.example.com/ingest',
        headers: { 'x-tenant': 'acme' },
        // Bearer credential resolved gateway-side by secret name; the value
        // never appears in config, logs, or audit.
        headerSecretName: 'SIEM_INGEST_TOKEN',
        timeoutMs: 3000,
      },
      // File sink — append-only JSON-Lines, e.g. for a local log shipper.
      { kind: 'file', path: '/var/log/skelm/audit-forward.jsonl' },
    ],
  },
})
```

Guarantees:

- **Best-effort.** A sink that throws or times out is logged and swallowed. It
  can never break the audit write or the gateway loop, and forwarding does not
  add latency to the audited action.
- **No secret leakage.** Only what the writer records is forwarded; audit rows
  carry names + non-secret metadata only. A sink's own credential is referenced
  by `headerSecretName` and resolved through the gateway secret resolver.
- **Pluggable.** `http` and `file` sinks ship in-box; the `AuditSink` interface
  (`@skelm/gateway`) lets you add your own.
