# multi-step-pipeline

A workflow that mixes deterministic, LLM, and (placeholder) agentic steps to show the full surface.

```
1. parse-input        deterministic   normalize the request
2. summarize          llm             ask the model for a one-line summary
3. dispatch-to-agent  agent (mock)    pretend to hand off to a coding agent
4. report             deterministic   build the final response
```

## Run

```bash
skelm run examples/multi-step-pipeline/multi-step.workflow.ts \
  --input '{"task":"investigate the login bug"}'
```

In an LLM-equipped environment (`OPENAI_API_KEY` set, `defaultBackend: 'openai'`), step 2 calls the real model; otherwise it falls back to a stubbed response so the example always runs.
