# Reference

Authoritative specifications for the skelm public surface.

## Overview

- [Packages](./packages.md) — the published `@skelm/*` package map and what each is for.

## Authoring

- [Pipeline Authoring](./pipeline-authoring.md) — builders, step kinds, control flow, structured output.
- [Agent Step](./agent-step.md) — full `agent()` signature: backends, workspace modes, MCP wiring, multi-turn control.
- [Permissions](./permissions.md) — every `AgentPermissions` dimension and how the gateway enforces it.
- [Workflow Packages](./workflow-packages.md) — `skelm.package.json` manifest, install cache, and `skelm.lock.json`.
- [Building Workflows](../guides/building-workflows.md) — project-directory resolution and the conversational `skelm builder`.

## Operating

- [CLI](./cli.md) — every `skelm` subcommand and flag.
- [Config](./config.md) — `skelm.config.ts` shape and defaults.
- [Gateway](./gateway.md) — long-running gateway surface: lifecycle, registries, control endpoints.

## Machine surfaces

- [API](./api.md) — generated TypeDoc per-package reference.
- [HTTP](./http.md) — gateway HTTP routes (prose).
- [OpenAPI](./openapi.md) — rendered OpenAPI 3.1 reference (with a download link to the raw YAML).
