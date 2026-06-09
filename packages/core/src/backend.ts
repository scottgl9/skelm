// SkelmBackend — the SPI for LLM providers, agent runtimes, and any
// other inference/execution backend skelm calls into.
//
// Two methods: `infer()` powers `infer()` steps (single-shot inference);
// `run()` powers `agent()` steps (multi-turn loops). A backend may
// implement only one. The capability flags tell the runtime what the
// backend can and cannot enforce natively.
//
// Implementation split across backend/:
//   agentmemory.ts — AgentmemoryHandle + all Agentmemory* types
//   types.ts        — request/response shapes + SkelmBackend interface
//   errors.ts       — all error classes
//   registry.ts     — BackendRegistry

export * from './backend/index.js'
