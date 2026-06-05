# skelm builder

A conversational agent — scaffolded by `skelm builder` — that **authors skelm
workflows** for you. Chat with it in your terminal; it consults the bundled
`skelm` skill, writes a `*.workflow.mts` into this folder, and validates it with
`skelm validate` before reporting the path.

## Run it

```bash
npm install        # first time only
skelm builder      # drops you into the chat UI (run from this folder or its parent)
```

`skelm builder` activates this project on the gateway and hosts the terminal
chat UI in your CLI process. Ctrl-C exits (the conversation is durable and
resumes next time).

## Backends

The agent backend resolves in `skelm.config.mts` with a runtime fallback:

1. **Codex** (default) — authenticates via the host `codex` CLI (`codex login`)
   or `CODEX_API_KEY`.
2. **Pi** (failover) — an in-process backend pointed at a local
   OpenAI-compatible endpoint, used automatically if a codex turn errors.

| Var | Default | Purpose |
| --- | --- | --- |
| `SKELM_BUILDER_BACKEND` | _(unset)_ | Pin a single backend: `codex` or `pi` (skips fallback) |
| `CODEX_API_KEY` | _(unset)_ | Codex API key (or run `codex login`) |
| `OPENAI_BASE_URL` | `http://localhost:8000/v1` | Pi endpoint |
| `OPENAI_MODEL` | `qwen36` | Pi model id |

## Permissions

The builder runs under explicitly declared, least-privilege grants (see
`builder.workflow.mts`): read the project, write generated files, run
`skelm` / `node`, and load the `skelm` skill. No unrestricted bypass.
