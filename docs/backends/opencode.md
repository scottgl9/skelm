# @skelm/opencode Backend

Full integration with opencode.ai coding agent via the official SDK, with granular permission enforcement and multi-agent support.

> **Status:** In development (M4)

## Overview

The `@skelm/opencode` backend provides:

- **Full permission enforcement** - skelm validates permissions before forwarding to opencode
- **Multi-agent support** - Use build, plan, or custom agents per pipeline step
- **Streaming responses** - Real-time token streaming with SSE
- **Dynamic configuration** - Per-pipeline agent and permission selection
- **Audit logging** - Full trace of permission decisions and executions

## Installation

```bash
npm i @skelm/opencode
```

## Configuration

### Basic Setup

```typescript
// skelm.config.ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    'opencode': {
      type: 'opencode',
      apiKey: process.env.OPENCODE_API_KEY,
      agent: 'build' // Default agent (build, plan, or custom)
    }
  }
})
```

### Advanced Configuration

```typescript
{
  type: 'opencode',
  apiKey: process.env.OPENCODE_API_KEY,
  
  // Agent selection
  agent: 'build', // 'build', 'plan', or custom agent ID
  
  // Permission defaults (can be overridden per pipeline)
  permissions: {
    edit: 'allow',
    bash: 'ask',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    task: 'allow'
  },
  
  // Model override (optional)
  model: 'anthropic/claude-sonnet-4-20250514',
  
  // Temperature (optional)
  temperature: 0.7,
  
  // Max steps before forcing text response (optional)
  maxSteps: 50,
  
  // API configuration
  apiUrl: 'https://api.opencode.ai', // Override if using self-hosted
  timeout: 60000, // Request timeout in ms
  maxRetries: 3,
  
  // Logging
  logLevel: 'info' // 'debug' | 'info' | 'warn' | 'error' | 'off'
}
```

## Usage

### Basic Pipeline Step

```typescript
import { pipeline, agent } from 'skelm'

export default pipeline({
  id: 'code-review',
  steps: [
    agent({
      id: 'reviewer',
      backend: 'opencode',
      agentDef: './agents/code-reviewer',
      permissions: {
        edit: 'deny',    // Read-only
        bash: 'deny',    // No shell access
        read: 'allow'    // Can read files
      },
      prompt: (ctx) => `Review this PR:\n${ctx.steps.fetch.pr}`
    })
  ]
})
```

### Multi-Agent Workflow

```typescript
import { pipeline, agent, parallel } from 'skelm'

export default pipeline({
  id: 'full-cycle',
  steps: [
    agent({
      id: 'builder',
      backend: 'opencode',
      agentDef: './agents/developer',
      permissions: {
        edit: 'allow',
        bash: 'ask'
      },
      prompt: 'Implement the feature'
    }),
    parallel([
      agent({
        id: 'reviewer',
        backend: 'opencode',
        agentDef: './agents/reviewer',
        permissions: { edit: 'deny', bash: 'deny' },
        prompt: 'Review the implementation'
      }),
      agent({
        id: 'tester',
        backend: 'opencode',
        agentDef: './agents/qa',
        permissions: { edit: 'deny', bash: 'allow' },
        prompt: 'Write tests for the feature'
      })
    ])
  ]
})
```

### Custom Agent Configuration

```typescript
// Define a custom agent in your opencode config
// opencode.json
{
  "agent": {
    "security-auditor": {
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514",
      "prompt": "{file:./prompts/security-auditor.txt}",
      "permission": {
        "edit": "deny",
        "bash": "deny",
        "read": "allow"
      }
    }
  }
}

// Use it in your pipeline
agent({
  id: 'auditor',
  backend: 'opencode',
  agent: 'security-auditor', // Custom agent ID
  permissions: {
    edit: 'deny',
    bash: 'deny',
    read: 'allow'
  }
})
```

## Permission Mapping

The opencode backend maps skelm permissions to opencode's permission system:

| skelm Permission | Opencode Permission | Description |
|-----------------|---------------------|-------------|
| `edit` | `edit` | File writes, patches, edits |
| `bash` | `bash` | Shell command execution |
| `read` | `read` | File reading |
| `glob` | `glob` | File pattern matching |
| `grep` | `grep` | Text search |
| `list` | `list` | Directory listing |
| `task` | `task` | Subagent invocation |
| `external_*` | `external_*` | External tool/MCP servers |

### Permission Values

- **`allow`** - Permission granted, no approval needed
- **`ask`** - Request user approval before execution
- **`deny`** - Permission denied, execution fails

## Features

### Streaming Responses

The backend supports real-time streaming via Server-Sent Events (SSE):

```typescript
// Streaming is automatic - events are emitted to your event handler
// Listen for token events in your pipeline runner
```

### Error Handling

The backend maps opencode errors to skelm's error types:

| Opencode Error | skelm Error |
|---------------|-------------|
| `APIError` | `BackendError` |
| `AuthenticationError` | `BackendError` (auth failed) |
| `PermissionDeniedError` | `PermissionDeniedError` |
| `NotFoundError` | `BackendError` |
| `RateLimitError` | `BackendError` (retryable) |
| `InternalServerError` | `BackendError` (retryable) |

### Retry Logic

Built-in retry for transient errors:

- Connection errors: 3 retries with exponential backoff
- Rate limits: 3 retries with Retry-After header
- Server errors: 3 retries with exponential backoff
- Timeout: Configurable (default 60s)

## MCP Server Passthrough

MCP servers configured in your pipeline are forwarded to opencode:

```typescript
agent({
  id: 'agent',
  backend: 'opencode',
  mcp: [
    { 
      id: 'github', 
      transport: 'stdio', 
      command: 'mcp-github',
      args: ['--token', process.env.GH_TOKEN]
    }
  ],
  permissions: {
    allowedMcpServers: ['github']
  }
})
```

## Audit Logging

All permission decisions are logged:

```typescript
// In your audit log
{
  "runId": "run_abc123",
  "stepId": "builder",
  "timestamp": "2026-05-03T16:00:00Z",
  "event": "permission_check",
  "details": {
    "tool": "edit",
    "path": "/path/to/file.ts",
    "decision": "allow",
    "backend": "opencode"
  }
}
```

## Troubleshooting

### Authentication Errors

```
Error: Authentication failed - check OPENCODE_API_KEY
```

**Solution:** Set `OPENCODE_API_KEY` environment variable or configure in backend config.

### Permission Denied

```
Error: Permission denied - edit not allowed for this agent
```

**Solution:** Check pipeline permissions and ensure the agent has `edit: 'allow'`.

### Connection Timeout

```
Error: Request timeout after 60000ms
```

**Solution:** Increase timeout in backend config or check network connectivity.

### Agent Not Found

```
Error: Agent 'custom-agent' not found
```

**Solution:** Ensure the agent is defined in your `opencode.json` config or use a built-in agent ('build' or 'plan').

## See Also

- [Opencode Documentation](https://opencode.ai/docs)
- [Opencode SDK](https://github.com/anomalyco/opencode-sdk-js)
- [Backends Overview](./README.md)
- [Permission System](../architecture/permissions.md)
