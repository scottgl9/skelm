# Security Policy

Security is the first of skelm's three tenets. We take vulnerability reports seriously and aim to respond quickly.

## Supported versions

skelm is pre-1.0 and ships from `main`. Only the latest minor release on npmjs receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3   | :x:                |

When a vulnerability is fixed, the fix lands in the next patch release on npmjs and is called out in the [CHANGELOG](../docs/CHANGELOG.md) under a `Security` heading.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, use one of these channels:

1. **GitHub Security Advisory** (preferred): open a private advisory at <https://github.com/scottgl9/skelm/security/advisories/new>.
2. **Email**: <scottgl@gmail.com> with `[skelm security]` in the subject line.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, ideally with a minimal proof-of-concept.
- Affected version(s).
- Any suggested mitigation, if you have one.

We will acknowledge receipt within 72 hours and aim to provide an initial assessment within 7 days. Coordinated disclosure timelines are negotiated case by case.

## Scope

In scope:

- Bypasses of `AgentPermissions` enforcement (default-deny violations, missing-field-treated-as-allow, dimension confusion).
- Audit log tampering, replay, or write-path escapes.
- Privilege escalation across the gateway trust boundary (e.g. a backend writing audit, a tool resolving secrets without going through the gateway).
- Secret leakage to event streams, run history, or unauthorized clients.
- HTTP API authentication / authorization bypasses on `@skelm/gateway`.
- Sandbox escapes from per-agent workspaces, MCP servers, or coding-agent backends.

Out of scope (please don't report these):

- Vulnerabilities in transitive dependencies that don't have an exploitable path through skelm. (Report those upstream.)
- Bugs that require an attacker to already have full local access to the host running the gateway.
- Issues in third-party agent runtimes (Opencode, Pi, Copilot ACP, Claude Code) that don't manifest through skelm's enforcement layer.

## Threat model

skelm's design assumptions, kept short:

- The **gateway** is the single trust boundary. All privileged actions (exec, network, fs-write, tool dispatch, audit write, secret resolve) route through it.
- The **runtime** does not enforce permissions; the gateway does. A backend that cannot enforce a declared permission **must** fail at step start rather than silently continue.
- **Default-deny is structural.** Every permission dimension defaults to `undefined`, which the runtime treats as deny. This is enforced by `scripts/guards/default-deny-permissions.ts` and adversarial fixtures under `packages/core/test/security/`.
- **Secrets are resolved at the gateway and passed by reference to backends** — never embedded in workflow source or events.
- **The audit log is single-writer, hash-chained, and separate from run history.** It is the artifact a compliance review reads.

If your report exposes a hole in any of these assumptions, that is the most valuable kind of report we can receive.
