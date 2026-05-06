---
'@skelm/gateway': minor
'@skelm/cli': minor
---

Add operational log infrastructure (issue #44, phase 1):

- `@skelm/gateway` — `LogEntry` / `LogSink` types, plus `RingBufferLogSink`,
  `FileLogSink`, and `TeeLogSink` implementations. Sensitive fields and
  secret-shaped values are redacted by the sink, never by the producer or
  the consumer. `redact()` is exported for callers that want the same
  redaction policy elsewhere.
- `@skelm/cli` — `skelm logs [--lines N] [--since iso] [--level lvl]
  [--filter substring] [--json]` reads the gateway's JSON-Lines log file
  (default `~/.skelm/gateway.log`, override via `SKELM_GATEWAY_LOG`).

The streaming endpoint (`GET /logs/stream`) and `skelm tail` follower
remain as a phase-2 follow-up.
