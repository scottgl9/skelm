import { createCodexBackend } from '@skelm/codex'
import { defineConfig } from 'skelm'

// The gateway resolves backends from the config it is *started* with, so run
// the gateway from this directory (`cd builder && skelm gateway start`) to make
// the codex backend below the one the builder run uses. Codex authenticates via
// the host `codex` CLI (`codex login`) or CODEX_API_KEY.
export default defineConfig({
  entrypoint: './builder.workflow.mts',
  // `openai: undefined` suppresses the framework-default openai backend, which
  // would otherwise be constructed at startup and demand OPENAI_API_KEY.
  backends: { agent: 'codex', llm: 'codex', openai: undefined },
  instances: [
    createCodexBackend({
      id: 'codex',
      // Omit to use the model from the host codex config; override with CODEX_MODEL.
      ...(process.env.CODEX_MODEL !== undefined && { model: process.env.CODEX_MODEL }),
    }),
  ],
})
