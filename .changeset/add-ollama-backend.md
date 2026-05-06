---
'@skelm/ollama': minor
---

Add `@skelm/ollama` — local-model backend that targets Ollama by default and
works against any OpenAI-compatible server (vLLM, LM Studio, llama.cpp,
etc.). Implements the `infer()` path of the SkelmBackend SPI; declares
`toolPermissions: 'unsupported'` so the runtime fails closed for tool-use
rather than silently degrading. Removes the API-key barrier from the on-ramp:
contributors and CI can exercise full agent flows keylessly.
