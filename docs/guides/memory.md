# Memory Primitives

skelm's durable state model is exposed through typed primitives instead of
ad hoc file access. The gateway owns the storage boundary and exposes selected
read surfaces for operators and dashboards.

## Public Contracts

`@skelm/core` exports these memory-facing interfaces:

- `ExecutionStore`: run records and run events
- `ArtifactStore`: workspace-backed run artifacts
- `WorkflowStateStore` / `StateStore`: workflow key-value state, CAS, and journals
- `AuditLogReader`: filtered audit-log reads and optional chain verification
- `DurableAgentMemory`: future-facing record/query/delete shape for agent memory
- `RunStore`: combined execution, state, and artifact store

The default usable implementations remain `MemoryRunStore` for tests and local
embedding, and `SqliteRunStore` for the gateway's local durable default.

## Gateway HTTP Surface

The dashboard and operators can inspect memory through gateway routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/runs/:runId/events` | persisted run events |
| `GET` | `/runs/:runId/artifacts` | artifact descriptors for a run |
| `GET` | `/runs/:runId/artifacts/:artifactId` | artifact bytes |
| `GET` | `/audit` | filtered audit entries |
| `GET` | `/audit/verify` | audit-chain verification |
| `GET` | `/v1/state/:namespace` | workflow KV state listing |
| `GET` | `/v1/state/:namespace/:key` | workflow KV state value |
| `GET` | `/v1/agentmemory/status` | agentmemory integration status |
| `GET` | `/v1/agentmemory/sessions` | agentmemory session summaries |

All routes run behind the gateway HTTP auth middleware when bearer auth is
enabled.

## Agent Memory Shape

`DurableAgentMemory` is intentionally conservative. It models durable records
with `id`, `scope`, `content`, metadata, and timestamps, plus scoped query and
delete operations. The current gateway agentmemory integration still talks to
the external agentmemory service; the core interface gives future in-process or
pluggable memory stores a stable shape without coupling workflow code to files.
