# skelm Backends

A backend is the bridge between skelm's `agent()` step and an AI coding agent or LLM provider. Each backend implements the `SkelmBackend` interface and handles:

- Prompt construction and system message injection
- Tool/MCP server negotiation
- Permission enforcement (or delegation)
- Streaming response handling
- Error mapping and retry logic

## Built-in Backends

### ACP Backends (Agent Client Protocol)

ACP backends spawn a subprocess that speaks the Agent Client Protocol over stdio.

- **`@skelm/acp-copilot`** - GitHub Copilot via `copilot-acp`
- **`@skelm/acp-anthropic`** - Claude Code via `claude`
- **`@skelm/acp-gemini`** - Gemini CLI via `gemini`

**Limitations:**
- Permission enforcement is advisory only (backend forwards permissions as metadata)
- No granular tool/skill filtering at the skelm layer
- Execution control depends on the underlying agent's configuration

**Best for:** Quick setup, existing ACP-compatible agents, editor integrations

### SDK Backends (Full Control)

SDK backends use official SDKs for direct API integration with enhanced permission control.

- **`@skelm/opencode`** - Opencode.ai with full permission enforcement ✅ **RECOMMENDED**
- **`@skelm/copilot-sdk`** - GitHub Copilot SDK (in development)
- **`@skelm/pi`** - Pi coding-agent (pending research)

**Advantages:**
- Granular permission enforcement at the skelm layer
- Dynamic agent configuration per pipeline
- Full streaming and error handling
- No subprocess management overhead

**Best for:** Production deployments, strict permission requirements, multi-tenant setups

### Direct LLM Backends

Direct LLM backends call provider APIs without agent loop capabilities.

- **`@skelm/openai`** - OpenAI chat completions
- **`@skelm/anthropic`** - Anthropic messages API
- **`@skelm/google`** - Google Gemini (in development)

**Best for:** Simple inference tasks, cost optimization, specific model requirements

## Permission Enforcement Model

| Backend Type | Permission Enforcement | Tool Filtering | Execution Control |
|--------------|----------------------|----------------|-------------------|
| ACP | Advisory (metadata only) | ❌ No | ❌ Limited |
| SDK | Enforced (skelm layer) | ✅ Yes | ✅ Full |
| Direct LLM | Enforced (skelm layer) | ✅ Yes | ✅ Full |

**Recommendation:** Use SDK backends (`@skelm/opencode`) for production workflows requiring strict permission enforcement. Use ACP backends for development and testing with existing ACP agents.

## Configuration Example

```typescript
// skelm.config.ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    // SDK backend with full control (recommended)
    'opencode': {
      type: 'opencode',
      apiKey: process.env.OPENCODE_API_KEY,
      agent: 'build', // or 'plan', or custom agent ID
      permissions: {
        edit: 'allow',
        bash: 'ask',
        read: 'allow'
      }
    },
    
    // ACP backend for development
    'copilot-dev': {
      type: 'acp',
      command: 'copilot-acp',
      // Permissions are advisory only
    }
  }
})
```

## Creating a Custom Backend

Implement the `SkelmBackend` interface:

```typescript
import type { SkelmBackend, AgentRequest, AgentResponse, BackendContext } from 'skelm'

export const myCustomBackend: SkelmBackend = {
  id: 'my-backend',
  capabilities: {
    prompt: true,
    streaming: true,
    toolPermissions: 'enforced', // or 'advisory' | 'unsupported'
    // ... other capabilities
  },
  
  async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
    // Implement your backend logic
    // Handle streaming, permissions, errors, etc.
    return {
      text: 'response',
      stopReason: 'complete'
    }
  }
}
```

See `packages/core/src/acp/backend.ts` and `packages/core/src/anthropic/backend.ts` for reference implementations.

## Backend Selection

Select a backend per pipeline or per step:

```typescript
import { pipeline, agent } from 'skelm'

export default pipeline({
  id: 'my-workflow',
  steps: [
    agent({
      id: 'coder',
      backend: 'opencode', // SDK backend with full control
      agentDef: './agents/developer',
      permissions: {
        edit: 'allow',
        bash: 'ask'
      }
    }),
    agent({
      id: 'reviewer',
      backend: 'copilot-dev', // ACP backend for quick iteration
      agentDef: './agents/reviewer',
      permissions: {
        edit: 'deny',
        bash: 'deny'
      }
    })
  ]
})
```

## Migration Guide

### From ACP to SDK Backend

If you're currently using an ACP backend and want full permission control:

1. Install the SDK backend: `npm i @skelm/opencode`
2. Configure the backend in `skelm.config.ts`
3. Update your pipeline to use the new backend ID
4. Verify permissions are enforced (check audit logs)

### Permission Mapping

SDK backends map skelm permissions to the underlying agent's permission system:

| skelm Permission | Opencode Permission |
|-----------------|---------------------|
| `edit` | `edit` |
| `bash` | `bash` |
| `read` | `read` |
| `glob` | `glob` |
| `grep` | `grep` |
| `list` | `list` |
| `task` | `task` |
| `external_*` | `external_*` |

## Troubleshooting

### Backend fails to start

- Check API key is set (`OPENCODE_API_KEY`, `OPENAI_API_KEY`, etc.)
- Verify the backend command is in PATH (for ACP backends)
- Check logs for connection errors

### Permissions not enforced

- Ensure you're using an SDK backend (ACP backends only forward permissions as metadata)
- Check the backend's `capabilities.toolPermissions` value
- Review audit logs for denial entries

### Streaming issues

- Verify SSE support in your network (for SDK backends)
- Check subprocess stdio handling (for ACP backends)
- Review error handling in your pipeline

## See Also

- [Architecture: Backends](../architecture/backends.md)
- [API Reference: SkelmBackend](../api/backend-interface.md)
- [Tutorial: Adding a Backend](../tutorials/custom-backend.md)
