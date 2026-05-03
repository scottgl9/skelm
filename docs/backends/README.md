# skelm Providers and Backends

## Architecture Overview

skelm separates provider abstractions into two distinct types:

### ModelProvider (LLM Endpoints)

Model providers handle direct LLM API interactions for `llm()` steps in workflows. They support:

- Multiple LLM endpoints (OpenAI, Anthropic, vllm, sglang, ollama, gemini)
- Chat completion with system prompts
- Streaming responses
- Token usage tracking
- Model discovery

**Use ModelProvider for:**
- Direct LLM inference without agent loops
- Cost optimization with specific models
- Simple text generation tasks

### AgentProvider (Coding Agent SDKs)

Agent providers integrate with coding agent SDKs for `agent()` steps. They support:

- Full agent loop execution with tool calls
- Permission enforcement at the skelm layer
- MCP server negotiation
- Workspace management
- Streaming and error handling

**Use AgentProvider for:**
- Complex coding workflows
- Multi-turn agent interactions
- Production deployments with strict permissions

### SkelmBackend Interface

The `SkelmBackend` interface is implemented by AgentProviders and represents the bridge between skelm's `agent()` step and an AI coding agent.

## Provider Types

### Model Providers

| Provider | Type | Status |
|----------|------|--------|
| OpenAI | Direct API | ✅ Available |
| Anthropic | Direct API | ✅ Available |
| vllm | Local inference | ✅ Available |
| sglang | Local inference | ✅ Available |
| Ollama | Local inference | ✅ Available |
| Google Gemini | Direct API | 🚧 In Development |

### Agent Providers

| Provider | Type | Status | Recommendation |
|----------|------|--------|----------------|
| Opencode | SDK | ✅ Available | ⭐ Recommended |
| ACP (Copilot) | Subprocess | ✅ Available | Development only |
| ACP (Claude Code) | Subprocess | ✅ Available | Development only |
| ACP (Gemini CLI) | Subprocess | ✅ Available | Development only |
| GitHub Copilot SDK | SDK | 🚧 In Development | - |
| Pi | SDK | 🔜 Pending | - |

## Configuration

### ModelProvider Configuration

```typescript
// skelm.config.ts
import { defineConfig, ModelRegistry } from 'skelm'

export default defineConfig({
  providers: {
    models: {
      'openai': {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: process.env.OPENAI_API_KEY,
        temperature: 0.7,
        maxTokens: 4096
      },
      'ollama': {
        provider: 'ollama',
        model: 'llama3',
        endpoint: 'http://localhost:11434'
      }
    }
  }
})
```

### AgentProvider Configuration

```typescript
// skelm.config.ts
import { defineConfig, AgentRegistry } from 'skelm'

export default defineConfig({
  providers: {
    agents: {
      'opencode': {
        provider: 'opencode',
        apiKey: process.env.OPENCODE_API_KEY,
        agent: 'build', // or 'plan', or custom agent ID
        permissions: {
          edit: 'allow',
          bash: 'ask',
          read: 'allow'
        },
        timeoutMs: 300000 // 5 minutes
      },
      'copilot-dev': {
        provider: 'acp',
        command: 'copilot-acp',
        // Permissions are advisory only for ACP
      }
    }
  }
})
```

## Using Providers in Workflows

### ModelProvider with `llm()` Step

```typescript
import { pipeline, llm } from 'skelm'

export default pipeline({
  id: 'text-processing',
  steps: [
    llm({
      id: 'summarize',
      backend: 'openai', // Uses ModelProvider
      system: 'You are a helpful summarizer.',
      prompt: 'Summarize: {{previous_step_output}}',
      temperature: 0.5
    })
  ]
})
```

### AgentProvider with `agent()` Step

```typescript
import { pipeline, agent } from 'skelm'

export default pipeline({
  id: 'coding-workflow',
  steps: [
    agent({
      id: 'coder',
      backend: 'opencode', // Uses AgentProvider
      agentDef: './agents/developer',
      permissions: {
        edit: 'allow',
        bash: 'ask'
      },
      mcp: [
        { name: 'filesystem', url: 'http://localhost:3000' }
      ]
    })
  ]
})
```

## Creating Custom Providers

### ModelProvider Implementation

```typescript
import { ModelProviderBase, ChatMessage, LlmCompletion } from 'skelm'

export class MyModelProvider extends ModelProviderBase {
  readonly id = 'my-provider'
  readonly name = 'My Custom Model Provider'
  
  async doInitialize(config: ModelProviderConfig): Promise<void> {
    // Initialize your provider (API clients, etc.)
  }
  
  async doComplete(
    messages: ChatMessage[],
    options?: Partial<ModelProviderConfig>
  ): Promise<LlmCompletion> {
    // Implement completion logic
    return {
      content: 'response',
      model: config.model,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
    }
  }
}
```

### AgentProvider Implementation

```typescript
import { AgentProviderBase, AgentRequest, AgentResponse } from 'skelm'
import type { SkelmBackend } from 'skelm'

export class MyAgentProvider extends AgentProviderBase {
  readonly id = 'my-agent-provider'
  readonly name = 'My Custom Agent Provider'
  
  async doInitialize(config: AgentProviderConfig): Promise<void> {
    // Initialize your provider (SDK clients, etc.)
  }
  
  async doCreateBackend(config?: Partial<AgentProviderConfig>): Promise<SkelmBackend> {
    // Return a SkelmBackend implementation
    return {
      id: 'my-backend',
      capabilities: {
        prompt: true,
        streaming: true,
        toolPermissions: 'enforced'
      },
      async run(request, context) {
        // Implement agent logic
        return { text: 'response', stopReason: 'complete' }
      }
    }
  }
  
  async doExecute(request: AgentRequest): Promise<AgentResponse> {
    // Execute agent request
    const backend = await this.createBackend()
    return backend.run(request, {})
  }
}
```

## Provider Registry

Both ModelProvider and AgentProvider implement registry patterns for managing multiple providers:

```typescript
import { ModelRegistry, AgentRegistry } from 'skelm'

// Model Registry
const modelRegistry = new ModelRegistry()
modelRegistry.register(new OpenAIModelProvider())
modelRegistry.setDefault('openai')

// Initialize all models
await modelRegistry.initializeAll({
  'openai': { provider: 'openai', model: 'gpt-4o', apiKey: '...' },
  'ollama': { provider: 'ollama', model: 'llama3', endpoint: '...' }
})

// Health check
const health = await modelRegistry.healthCheckAll()

// Agent Registry
const agentRegistry = new AgentRegistry()
agentRegistry.register(new OpencodeProvider())
agentRegistry.setDefault('opencode')

// Initialize all agents
await agentRegistry.initializeAll({
  'opencode': { provider: 'opencode', apiKey: '...', agent: 'build' }
})
```

## Migration Guide

### From Monolithic Provider to Separated Architecture

If you're using an older provider system that combined LLM and agent capabilities:

1. **Identify usage patterns:**
   - `llm()` steps → ModelProvider
   - `agent()` steps → AgentProvider

2. **Split configurations:**
   - Move LLM endpoint configs to `providers.models`
   - Move agent SDK configs to `providers.agents`

3. **Update imports:**
   ```typescript
   // Before
   import { ProviderPlugin } from 'skelm'
   
   // After
   import { ModelProviderBase } from 'skelm' // for LLM endpoints
   import { AgentProviderBase } from 'skelm' // for agent SDKs
   ```

4. **Update workflows:**
   - Ensure `llm()` steps reference `backend` from ModelProvider
   - Ensure `agent()` steps reference `backend` from AgentProvider

## Troubleshooting

### Provider not found

- Verify provider is registered: `registry.get('provider-id')`
- Check provider ID matches workflow configuration
- Review initialization logs for errors

### Model/Agent selection fails

- Set a default provider: `registry.setDefault('provider-id')`
- Ensure at least one provider is registered
- Check provider health: `registry.healthCheckAll()`

### Permission enforcement not working

- Use SDK-based AgentProvider (not ACP/subprocess)
- Verify `capabilities.toolPermissions = 'enforced'`
- Check audit logs for denial entries

## See Also

- [Architecture: Providers](../architecture/providers.md)
- [API Reference: ModelProvider](../api/model-provider.md)
- [API Reference: AgentProvider](../api/agent-provider.md)
- [Tutorial: Creating a Provider](../tutorials/custom-provider.md)
