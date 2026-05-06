---
'@skelm/cli': minor
---

Add `skelm approvals config` for managing the approval policy file:

- `skelm approvals config show [--json]` — print the effective policy
- `skelm approvals config validate [--json]` — static-check the policy
  (parse error, bad timeout, unknown step kind, duplicate approver id,
  missing approver id)
- `skelm approvals config set <key> <value>` — set `defaultTimeoutMs`
  or `stepKindsRequiringApproval` (comma-separated list); writes are
  atomic via tmp+rename
- `skelm approvals config approvers add|remove <id>` — manage the
  approver registry

Reads/writes `$SKELM_APPROVALS_CONFIG` (default
`~/.skelm/approvals.config.json`), with file mode `0600`.
The gateway re-reads the policy on `skelm gateway reload`.

Routing the writes through the gateway HTTP surface (so policy changes
land in the audit chain) remains a follow-up.
