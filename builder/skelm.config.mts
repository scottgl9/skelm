import { createPiSdkBackend } from '@skelm/pi'
import { defineConfig } from 'skelm'

// The gateway resolves backends from the config it is *started* with, so run
// the gateway from this directory (`cd builder && skelm gateway start`) to make
// the pi backend below the one the builder run uses. The pi SDK backend runs
// the coding agent in-process (no OS sandbox) and points at a local
// OpenAI-compatible endpoint via OPENAI_BASE_URL / OPENAI_MODEL.
export default defineConfig({
  entrypoint: './builder.workflow.mts',
  // `openai: undefined` suppresses the framework-default openai backend, which
  // would otherwise be constructed at startup and demand OPENAI_API_KEY.
  backends: { agent: 'pi-sdk', llm: 'pi-sdk', openai: undefined },
  instances: [
    createPiSdkBackend({
      id: 'pi-sdk',
      baseUrl: process.env.OPENAI_BASE_URL ?? 'http://localhost:8000/v1',
      apiKey: process.env.OPENAI_API_KEY ?? 'unused',
      model: process.env.OPENAI_MODEL ?? 'qwen36',
    }),
  ],
})
