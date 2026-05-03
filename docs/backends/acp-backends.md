# ACP Backends

Agent Client Protocol (ACP) backends for skelm, providing integration with ACP-compatible coding agents.

> **Status:** Stable (M1)

## Overview

ACP backends spawn a subprocess that communicates with skelm over the Agent Client Protocol via stdio. This provides:

- **Broad compatibility** - Works with any ACP-compatible agent
- **Simple setup** - No API keys required (agent handles authentication)
- **Editor integration** - Same agents used in editors work in skelm
- **Local execution** - All code runs locally, no external API calls

## Limitations

**Important:** ACP backends have limited permission enforcement:

- ⚠️ **Permissions are advisory only** - Forwarded as metadata to the agent
- ⚠️ **No enforcement at skelm layer** - Agent decides whether to comply
- ⚠️ **No audit of denials** - Cannot track what the agent refused
- ⚠️ **No tool filtering** - All tools available to agent are accessible

**Recommendation:** Use ACP backends for development and testing. For production workflows requiring strict permission enforcement, use SDK backends like `@skelm/opencode`.

## Supported ACP Backends

### GitHub Copilot

```typescript
// skelm.config.ts
export default defineConfig({
  backends: {
    'copilot': {
      type: 'acp',
      command: 'copilot-acp',
      args: [] // Optional additional arguments
    }
  }
})
```

**Requirements:**
- GitHub Copilot installed in your editor
- `copilot-acp` command available in PATH
- Authentication via editor session

### Claude Code

```typescript
// skelm.config.ts
export default defineConfig({
  backends: {
    'claude': {
      type: 'acp',
      command: 'claude',
      args: ['--acp'] // Claude Code ACP mode
    }
  }
})
```

**Requirements:**
- Claude Code CLI installed: `npm install -g @anthropic-ai/claude-code`
- `CLAUDE_API_KEY` environment variable
- `--acp` flag for ACP mode

### Gemini CLI

```typescript
// skelm.config.ts
export default defineConfig({
  backends: {
    'gemini': {
      type: 'acp',
      command: 'gemini',
      args: ['--acp'] // Gemini CLI ACP mode
    }
  }
})
```

**Requirements:**
- Gemini CLI installed: `brew install gemini` or via Homebrew
- `GOOGLE_API_KEY` environment variable
- `--acp` flag for ACP mode

### OpenCode

```typescript
// skelm.config.ts
export default defineConfig({
  backends: {
    'opencode': {
      type: 'acp',
      command: 'opencode',
      args: ['acp'] // OpenCode ACP mode
    }
  }
})
```

**Requirements:**
- OpenCode installed: `brew install anomalyco/tap/opencode`
- `OPENCODE_API_KEY` environment variable (or use OpenCode Zen)
- `acp` subcommand for ACP mode

## Configuration

### Basic Setup

```typescript
{
  type: 'acp',
  command: 'copilot-acp',
  args: [],           // Optional additional arguments
  cwd: process.cwd(), // Working directory for subprocess
  env: {}            // Environment variables for subprocess
}
```

### Advanced Setup

```typescript
{
  type: 'acp',
  command: 'claude',
  args: ['--acp', '--model', 'claude-sonnet-4'],
  cwd: '/path/to/workspace',
  env: {
    CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
    CUSTOM_VAR: 'value'
  }
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
      backend: 'copilot', // Uses ACP backend
      agentDef: './agents/reviewer',
      // Note: These permissions are advisory only
      permissions: {
        edit: 'allow',
        bash: 'deny',
        read: 'allow'
      },
      prompt: 'Review this code'
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
      backend: 'claude',
      agentDef: './agents/developer',
      permissions: { edit: 'allow', bash: 'ask' },
      prompt: 'Implement the feature'
    }),
    parallel([
      agent({
        id: 'reviewer',
        backend: 'gemini',
        agentDef: './agents/reviewer',
        permissions: { edit: 'deny', bash: 'deny' },
        prompt: 'Review the implementation'
      }),
      agent({
        id: 'tester',
        backend: 'opencode',
        agentDef: './agents/qa',
        permissions: { edit: 'deny', bash: 'allow' },
        prompt: 'Write tests'
      })
    ])
  ]
})
```

## Permission Behavior

### What Happens with ACP Backends

1. **Pipeline declares permissions** - Your pipeline specifies `AgentPermissions`
2. **Backend forwards as metadata** - Permissions sent to ACP agent as advisory info
3. **Agent decides** - Agent may or may not respect the permissions
4. **No enforcement at skelm layer** - skelm doesn't block execution

### Example Flow

```typescript
// Pipeline declares: bash: 'deny'
agent({
  id: 'agent',
  backend: 'copilot',
  permissions: { bash: 'deny' },
  prompt: 'Run a bash command'
})

// What actually happens:
// 1. skelm sends prompt + permissions (as metadata) to copilot-acp
// 2. copilot-acp receives the request
// 3. copilot-acp MAY respect the bash: 'deny' permission
// 4. copilot-acp MAY ignore it and execute anyway
// 5. skelm has no way to know or enforce
```

### Audit Logging Limitations

With ACP backends:
- ✅ Permission checks are logged
- ❌ Actual execution decisions are NOT logged
- ❌ Denials by the agent are NOT tracked
- ❌ Cannot query "what was denied" in audit logs

## Troubleshooting

### Subprocess Fails to Start

```
Error: Failed to start ACP subprocess: command not found
```

**Solution:** Ensure the ACP command is in your PATH. Test with:
```bash
which copilot-acp
which claude
which gemini
which opencode
```

### Authentication Errors

```
Error: Authentication failed
```

**Solution:** Authenticate with the underlying agent:
- **Copilot:** Sign in via your editor
- **Claude:** Set `CLAUDE_API_KEY`
- **Gemini:** Set `GOOGLE_API_KEY`
- **OpenCode:** Set `OPENCODE_API_KEY` or use OpenCode Zen

### No Response from Agent

```
Error: Timeout waiting for ACP response
```

**Solution:**
- Check agent logs for errors
- Verify the agent works in your editor
- Increase timeout in backend config
- Check for subprocess resource limits

### Permissions Not Being Respected

```
Agent executed bash command despite bash: 'deny'
```

**Solution:** This is expected behavior with ACP backends. The permissions are advisory only. For enforcement, use an SDK backend like `@skelm/opencode`.

## Migration to SDK Backends

If you need strict permission enforcement, migrate from ACP to SDK backends:

### From Copilot ACP to Copilot SDK

```typescript
// Before
{
  type: 'acp',
  command: 'copilot-acp'
}

// After
{
  type: 'copilot-sdk',
  apiKey: process.env.GITHUB_TOKEN
}
```

### From OpenCode ACP to OpenCode SDK

```typescript
// Before
{
  type: 'acp',
  command: 'opencode',
  args: ['acp']
}

// After
{
  type: 'opencode',
  apiKey: process.env.OPENCODE_API_KEY,
  agent: 'build'
}
```

## Comparison: ACP vs SDK

| Feature | ACP Backend | SDK Backend |
|---------|-------------|-------------|
| Setup | Simple (command only) | Requires API key |
| Permission Enforcement | Advisory only | Enforced |
| Audit Logging | Limited | Full |
| Subprocess Management | Required | None |
| Local Execution | Yes | Depends on agent |
| Editor Integration | Same agents | Separate SDK |
| Production Ready | Development only | Yes |

## See Also

- [Agent Client Protocol](https://agentclientprotocol.com)
- [ACP Support Report](https://github.com/acp-progress/report)
- [SDK Backends](./README.md#sdk-backends)
- [Opencode Backend](./opencode.md)
- [Copilot SDK Backend](./copilot-sdk.md)
