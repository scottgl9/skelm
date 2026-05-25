# skelm builder

A skelm workflow that **builds other skelm workflows** from a natural-language
spec — skelm, dogfooding itself.

`builder.workflow.mts` runs an `agent()` step (driven by the
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent
SDK backend) that consults the bundled `skelm` skill, authors a new
`*.workflow.mts`, writes it, and self-checks it with `skelm validate` before
returning `{ path, summary, permissions }`. A leading `wait()` step prompts for
the spec interactively when one isn't passed up front.

The pi SDK backend runs the agent **in-process** (no OS sandbox), so it works on
hosts where bubblewrap-based sandboxes can't initialize, and it points at any
local OpenAI-compatible endpoint.

## Run it

The gateway resolves backends from the config it is **started** with, so start
the gateway from this directory so it picks up `skelm.config.mts` (which wires
the pi backend and declares the `entrypoint`):

```bash
cd builder
# Defaults target a local server at http://localhost:8000/v1 with model qwen36.
skelm gateway start                # foreground; Ctrl-C to stop
# Override the endpoint/model:
# OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_MODEL=qwen36 skelm gateway start
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

| Var               | Default                    | Purpose                            |
| ----------------- | -------------------------- | ---------------------------------- |
| `OPENAI_BASE_URL` | `http://localhost:8000/v1` | OpenAI-compatible LLM endpoint     |
| `OPENAI_MODEL`    | `qwen36`                   | Model id                           |
| `OPENAI_API_KEY`  | `unused`                   | API key (local servers ignore it)  |

## Permissions

The `build` agent runs under least-privilege, self-contained grants: read the
project, write generated files, run `skelm` / `node`, and load the `skelm`
skill. `networkEgress` is `allow` because the in-process pi-sdk backend can't
route agent traffic through the gateway egress proxy — skelm fails closed on any
narrower policy for this backend (use the pi RPC or opencode subprocess backends
when you need the egress proxy to enforce a restricted network policy).

`skills/skelm/SKILL.md` is a symlink to the repo's canonical skelm skill so the
agent loads a single source of truth.

> **Note:** small local models reliably write the workflow but don't always end
> with a strict JSON summary, so `finalize` recovers the result from the agent's
> output (preferring a JSON object if one was emitted, else the generated path).
