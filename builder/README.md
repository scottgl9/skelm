# skelm builder

A skelm workflow that **builds other skelm workflows** from a natural-language
spec — skelm, dogfooding itself.

`builder.workflow.mts` runs an `agent()` step (driven by the
[Codex](https://www.npmjs.com/package/@openai/codex-sdk) coding-agent backend)
that consults the bundled `skelm` skill, authors a new `*.workflow.mts`, writes
it, and self-checks it with `skelm validate` before returning
`{ path, summary, permissions }`. A leading `wait()` step prompts for the spec
interactively when one isn't passed up front.

## Run it

The gateway resolves backends from the config it is **started** with, so start
the gateway from this directory so it picks up `skelm.config.mts` (which wires
the Codex backend and declares the `entrypoint`). Codex authenticates via the
host `codex` CLI (`codex login`) or `CODEX_API_KEY`:

```bash
cd builder
skelm gateway start                # foreground; Ctrl-C to stop
# Optionally pin a model: CODEX_MODEL=gpt-5.3-codex skelm gateway start
```

Then, from the repo root:

```bash
# One-shot: pass the spec as JSON input
skelm run builder --input '{"spec":"a workflow that summarizes a GitHub issue"}'

# Interactive: omit --input and answer the prompt
skelm run builder
```

`skelm run builder` resolves this directory to `builder.workflow.mts` via the
`entrypoint` field in `skelm.config.mts`.

## Environment

| Var            | Default                | Purpose                                  |
| -------------- | ---------------------- | ---------------------------------------- |
| `CODEX_MODEL`  | host codex config      | Override the Codex model id              |
| `CODEX_API_KEY`| —                      | API key, if not using `codex login`      |

## Permissions

The `build` agent runs under least-privilege, self-contained grants: read the
project, write generated files, and run `skelm` / `node` — nothing else, and no
agent-tool network egress (Codex reaches the model API in its own process, not
through a tool).

`skills/skelm/SKILL.md` is a symlink to the repo's canonical skelm skill so the
agent loads a single source of truth.

> **Note:** Codex enforces its own bubblewrap sandbox for shell/file tools. On
> hosts that block unprivileged user namespaces (e.g. AppArmor's
> `kernel.apparmor_restrict_unprivileged_userns=1`), that sandbox cannot
> initialize and Codex's file writes/exec will fail. Run on a host where
> unprivileged userns is permitted, or use a backend with in-process tools.
