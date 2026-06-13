# Security auditor

`@skelm/security-auditor` is a first-party workflow package that statically
audits skelm workflows and workflow packages for security issues. It inspects a
workflow **without executing it** and produces a structured findings report.

The auditor exists to make the security tenet checkable before a workflow ships:
default-deny is the model, but a workflow can still declare an over-broad
ceiling (write the whole filesystem, egress to any host, request an unrestricted
bypass) or leak a secret value into source. The auditor surfaces those as
findings with a severity, a stable rule id, a location, and a redaction-safe
detail.

## How it inspects without executing

The auditor never runs the workflow under audit. It combines two read-only
sources:

- **Structure** from [`deriveWorkflowGraph`](./workflow-graph.md): a pure,
  deterministic projection of the authored workflow. Deriving the graph confirms
  the workflow is well-formed and bounds the walk; no author `run` or predicate
  function is invoked.
- **Permission detail** read directly from the authored `Pipeline.steps`. The
  [WorkflowGraph permission summary](./workflow-graph.md) is deliberately
  redacted — it records which [permission](./permissions.md) dimensions a step
  declares but not the hosts, paths, executables, or secret names — so the
  detail rules read the raw `AgentPermissions` off each step.

The one source-level rule, the secret-value scan, runs over the workflow's
**source text**.

## Rules and severities

| Rule id | Default severity | Flags |
|---|---|---|
| `fs-write-broad` | high | An `fsWrite` root granting the project or filesystem root (`/`, `.`, `./`, `~`, `*`). |
| `network-egress-broad` | high (`allow`) / medium (wildcard) | `networkEgress: 'allow'`, or a wildcard host in `allowHosts`. |
| `unrestricted-grant` | high | A step sets `requestUnrestricted` — a full bypass if the operator also grants it. |
| `secret-value-in-source` | high | A literal secret **value** embedded in source (AWS, GitHub, Slack, OpenAI, Google, Stripe, or a private-key block). |
| `risky-executable-profile` | high | An allowed executable or referenced profile in the shell / package-manager / cloud-CLI class. |
| `missing-approval-privileged` | medium | A privileged dimension (`executable`, `network`, `fs.write`, `secret`, `mcp`) with no approval policy gating it. |
| `manifest-permission-drift` | medium | A [package manifest](./workflow-packages.md) and workflow disagree on which privileged permission dimensions are actually needed. |
| `unverified-webhook-trigger` | medium | A webhook trigger with no signing secret, provider, or `clientState`. |

## Secret redaction

A `secret-value-in-source` finding never carries the matched value. The scanner
discards the raw match inside the detection function and returns only a redacted
preview — at most the first four characters, with the remainder masked, e.g.
`AKIA****************`. A finding's `location` carries the file and 1-based line;
its `detail` carries the redacted preview and the secret kind. No code path
copies the value into the report, logs, or error messages.

## Configuration

`AuditConfig` controls rule toggles and the failure threshold:

```ts
import { auditWorkflow } from '@skelm/security-auditor'

const report = auditWorkflow(
  { workflow, source, file: 'my.workflow.ts' },
  {
    failOn: 'medium',
    rules: {
      'manifest-permission-drift': { enabled: false },
      'network-egress-broad': { severity: 'high' },
    },
  },
)
```

`failOn` (default `high`) is the lowest severity that makes `report.ok` false.
Each rule may be disabled with `enabled: false` or have its severity overridden.

## As a workflow package

The package ships a `default` entrypoint pipeline. It takes a loaded target
workflow as input (and optionally its source text and a manifest permission
ceiling) and returns the `AuditReport`. Because it only inspects the target, the
auditor workflow itself declares no privileged permissions.
