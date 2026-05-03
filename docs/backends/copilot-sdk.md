# @skelm/copilot-sdk Backend

GitHub Copilot SDK integration with enhanced permission control beyond ACP.

> **Status:** Planned (M4)

## Overview

The `@skelm/copilot-sdk` backend provides:

- **Enhanced permission enforcement** - Beyond ACP's advisory model
- **Direct SDK integration** - No subprocess management
- **Streaming responses** - Real-time token streaming
- **Model selection** - Choose from available Copilot models
- **Organization policies** - Respect enterprise Copilot configurations

## Installation

```bash
npm i @skelm/copilot-sdk
```

## Configuration

### Basic Setup

```typescript
// skelm.config.ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    'copilot': {
      type: 'copilot-sdk',
      apiKey: process.env.GITHUB_TOKEN,
      organization: process.env.GITHUB_ORG // Optional
    }
  }
})
```

### Advanced Configuration

```typescript
{
  type: 'copilot-sdk',
  apiKey: process.env.GITHUB_TOKEN,
  
  // Organization for enterprise features
  organization: process.env.GITHUB_ORG,
  
  // Model selection
  model: 'gpt-4o', // or specific Copilot model
  
  // Permission defaults
  permissions: {
    edit: 'allow',
    bash: 'ask',
    read: 'allow'
  },
  
  // API configuration
  apiUrl: 'https://api.github.com/copilot', // Override if needed
  timeout: 60000,
  maxRetries: 3
}
```

## Usage

### Basic Pipeline Step

```typescript
import { pipeline, agent } from 'skelm'

export default pipeline({
  id: 'code-generation',
  steps: [
    agent({
      id: 'coder',
      backend: 'copilot',
      agentDef: './agents/developer',
      permissions: {
        edit: 'allow',
        bash: 'ask',
        read: 'allow'
      },
      prompt: (ctx) => `Generate code for:\n${ctx.steps.spec}`
    })
  ]
})
```

## Permission Mapping

The copilot-sdk backend maps skelm permissions to GitHub Copilot's capabilities:

| skelm Permission | Copilot Capability | Description |
|-----------------|-------------------|-------------|
| `edit` | File edits | Code generation and modifications |
| `bash` | Shell commands | Terminal execution |
| `read` | File reading | Source code access |
| `glob` | File patterns | File discovery |
| `grep` | Text search | Code search |
| `list` | Directory listing | File system navigation |

## Features

### Enhanced Permission Control

Unlike ACP backends which only forward permissions as metadata, the SDK backend enforces permissions at the skelm layer:

- **Pre-execution validation** - Permissions checked before forwarding to Copilot
- **Audit logging** - All permission decisions logged
- **Dynamic filtering** - Tools/skills filtered per pipeline

### Organization Features

For enterprise customers:

- **Organization policies** - Respect enterprise Copilot configurations
- **Usage tracking** - Monitor API usage per organization
- **Compliance** - Audit trails for enterprise requirements

### Model Selection

Choose the appropriate model for your use case:

```typescript
{
  model: 'gpt-4o',        // General purpose
  model: 'gpt-4-turbo',   // Complex reasoning
  model: 'copilot-codex'  // Code-specific (if available)
}
```

## Migration from ACP Backend

If you're currently using `@skelm/acp-copilot`, migration is straightforward:

1. Install the SDK backend: `npm i @skelm/copilot-sdk`
2. Update your config:
   ```typescript
   // Before
   'copilot': { type: 'acp', command: 'copilot-acp' }
   
   // After
   'copilot': { type: 'copilot-sdk', apiKey: process.env.GITHUB_TOKEN }
   ```
3. Update your pipeline backend reference:
   ```typescript
   // Before
   backend: 'copilot-acp'
   
   // After
   backend: 'copilot'
   ```

## Comparison: ACP vs SDK

| Feature | ACP Backend | SDK Backend |
|---------|-------------|-------------|
| Permission Enforcement | Advisory only | Enforced |
| Subprocess Management | Required | None |
| Streaming | Yes | Yes |
| Error Handling | Basic | Comprehensive |
| Organization Features | No | Yes |
| Model Selection | Limited | Full |
| Audit Logging | Limited | Full |

## Troubleshooting

### Authentication Errors

```
Error: Authentication failed - check GITHUB_TOKEN
```

**Solution:** Set `GITHUB_TOKEN` with appropriate permissions (repo scope for private repos).

### Organization Not Found

```
Error: Organization 'my-org' not found
```

**Solution:** Verify organization name and that your token has org access.

### Rate Limiting

```
Error: Rate limit exceeded
```

**Solution:** Implement retry logic or upgrade Copilot plan.

## See Also

- [GitHub Copilot Documentation](https://docs.github.com/en/copilot)
- [Copilot SDK](https://github.com/github/copilot-sdk)
- [Backends Overview](./README.md)
- [ACP Backend](./acp-backends.md)
