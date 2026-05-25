# skelm builder

A skelm workflow that **builds other skelm workflows** from a natural-language
spec — skelm, dogfooding itself.

`builder.workflow.mts` runs an `agent()` step (driven by a local
OpenAI-compatible LLM) that loads the bundled `skelm` skill, authors a new
`*.workflow.mts`, writes it with `fs_write`, and self-checks it with
`skelm validate` before returning `{ path, summary, permissions }`. A leading
`wait()` step prompts for the spec interactively when one isn't passed up front.

## Run it

The gateway resolves backends from the config it is **started** with, so start
the gateway from this directory so it picks up `skelm.config.mts` (which wires
the local LLM backend and declares the `entrypoint`):

```bash
cd builder
OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_MODEL=<your-qwen-tag> \
  skelm gateway start            # foreground; Ctrl-C to stop
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

| Var               | Default                     | Purpose                        |
| ----------------- | --------------------------- | ------------------------------ |
| `OPENAI_BASE_URL` | `http://localhost:8000/v1`  | OpenAI-compatible LLM endpoint |
| `OPENAI_MODEL`    | `qwen2.5-coder`             | Model id                       |
| `OPENAI_API_KEY`  | `unused`                    | API key (most local servers ignore it) |

## Permissions

The `build` agent runs under the least-privilege `builder` profile: read the
project, write generated files, and run `skelm` / `node` — nothing else, and no
network egress (the backend reaches the LLM endpoint directly, not via a tool).

`skills/skelm/SKILL.md` is a symlink to the repo's canonical skelm skill so the
agent loads a single source of truth.
