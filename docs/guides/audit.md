# Audit log

The gateway writes a single, append-only, hash-chained audit log. One process per gateway instance owns it; the gateway lockfile (`gateway.lock`) doubles as the audit-writer claim.

## Where it lives

```
~/.skelm/audit.jsonl     # one line per entry, JSON
```

Override the directory via the `--state-dir` flag (Phase 11) or `SKELM_STATE_DIR` env var.

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

Phase 5 wires the writer; Phases 5–11 add producers. Coverage at v1:

- Gateway lifecycle: `gateway.start`, `gateway.stop`, `gateway.reload`, `gateway.plugin.load`.
- Permission decisions: `permission.deny` (Phase 4 enforcer hooks).
- Secret access: `secret.resolve` — name only, never value.
- Approvals: `approval.request`, `approval.approve`, `approval.deny` (Phase 6).
- Agent + session lifecycle: `agent.spawn`, `agent.exit`, `acp.session.create` (Phases 8–9).
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

## Compaction (deferred)

`skelm audit compact` lands at M3+. It snapshots, signs, and rolls — never edits — preserving verifiability across the snapshot boundary.
