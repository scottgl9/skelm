# @skelm/security-auditor

Static security auditor for skelm workflows and workflow packages. It inspects a
workflow **without executing it** and emits a structured findings report:
each finding names the rule that fired, its severity, where it is, and a
redaction-safe detail. A matched secret value is **never** printed — only the
file, line, and a redacted preview.

## How it inspects without executing

The auditor combines two read-only sources:

- **Structure** comes from `deriveWorkflowGraph` in `@skelm/core` — a pure,
  side-effect-free projection of the authored workflow (nodes, nested children,
  `codeOwned` regions). Deriving the graph confirms the workflow is well-formed
  and bounds what the auditor walks. No author `run`/predicate function is ever
  invoked.
- **Permission detail** comes from the authored `Pipeline.steps` directly. The
  graph's permission summary is deliberately redacted (it carries which
  dimensions are present but not the hosts, paths, executables, or secret names),
  so detail rules read the raw `AgentPermissions` off each step.

Source-level rules (the secret-value scan) run over the workflow's **source
text**, never its runtime behavior.

## Rules

| Rule id | Default severity | What it flags |
|---|---|---|
| `fs-write-broad` | high | An `fsWrite` root that grants the project root or filesystem root (`/`, `.`, `./`, `~`, `*`). |
| `network-egress-broad` | high (`allow`) / medium (wildcard) | `networkEgress: 'allow'` (any host), or a wildcard host in `allowHosts`. |
| `unrestricted-grant` | high | A step sets `requestUnrestricted` (a full permission bypass if the operator also grants it). |
| `secret-value-in-source` | high | A literal secret **value** (AWS key, GitHub/Slack/OpenAI/Stripe token, private-key block) embedded in source. Reported redacted. |
| `risky-executable-profile` | high | An allowed executable or referenced profile in the shell / package-manager / cloud-CLI class. |
| `missing-approval-privileged` | medium | A privileged dimension (`executable`, `network`, `fs.write`, `secret`, `mcp`) granted with no approval policy gating it. |
| `manifest-permission-drift` | medium | A package manifest and workflow disagree on which privileged permission dimensions are actually needed. |
| `unverified-webhook-trigger` | medium | A webhook trigger with no signing secret, provider, or `clientState` — deliveries cannot be authenticated. |

A finding's `detail` and `location` never contain a secret value: secret
findings carry only the file, the line, and a redacted preview such as
`AKIA****************`.

## Usage

As a library:

```ts
import { auditWorkflow } from '@skelm/security-auditor'

const report = auditWorkflow({ workflow, source, file: 'my.workflow.ts' })
if (!report.ok) {
  for (const f of report.findings) {
    console.error(`[${f.severity}] ${f.rule} @ ${f.location.file ?? f.location.stepId}: ${f.detail}`)
  }
}
```

As a workflow package, the `default` entrypoint (`workflows/audit.workflow.ts`)
takes a loaded target workflow as input and returns the `AuditReport`.

## Configuration

`AuditConfig` toggles rules and sets the failure threshold:

```ts
auditWorkflow(input, {
  failOn: 'medium', // ok=false when any finding is at or above this severity
  rules: {
    'manifest-permission-drift': { enabled: false },
    'network-egress-broad': { severity: 'high' },
  },
})
```

`failOn` defaults to `high`. Each rule can be disabled (`enabled: false`) or have
its severity overridden.
