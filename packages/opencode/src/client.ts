import { createOpencodeClient, OpencodeClient } from '@opencode-ai/sdk'
import type { AgentRequest, AgentResponse } from '@skelm/core'
import type { OpencodeBackendOptions } from './types.js'

/**
 * Opencode SDK client wrapper with session management
 */
export class OpencodeClientWrapper {
  private client: OpencodeClient
  private currentSessionId: string | null = null
  private options: OpencodeBackendOptions

  constructor(options: OpencodeBackendOptions) {
    this.options = options
    const apiKey = options.apiKey ?? process.env.OPENCODE_API_KEY

    if (!apiKey) {
      throw new Error('OPENCODE_API_KEY environment variable is required')
    }

    // Initialize SDK client with API key in headers
    this.client = createOpencodeClient({
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      ...(options.apiUrl && { baseURL: options.apiUrl }),
      ...(options.timeout && { timeout: options.timeout }),
      ...(options.maxRetries !== undefined && { maxRetries: options.maxRetries }),
    })
  }

  /**
   * Send a prompt to the opencode agent
   */
  async prompt(
    request: AgentRequest,
    _permissions: unknown, // Permissions enforced at skelm layer, passed as metadata
  ): Promise<AgentResponse> {
    // Create a new session if we don't have one
    if (!this.currentSessionId) {
      const result = await this.client.session.create()
      if (result.data) {
        this.currentSessionId = result.data.id
      } else {
        throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`)
      }
    }

    // Send prompt to the session
    const promptResult = await this.client.session.prompt({
      path: { id: this.currentSessionId },
      body: {
        agent: this.options.agent ?? 'build',
        ...(request.system && { system: request.system }),
        parts: [
          {
            type: 'text',
            text: request.prompt,
          },
        ],
      },
    })

    // For now, return a placeholder response
    // In production, we'd stream the response and aggregate it
    // The prompt endpoint returns events, not a direct response
    return {
      text: 'Response pending - streaming not yet implemented',
      stopReason: 'complete',
    }
  }

  /**
   * Cancel the current request
   */
  async cancel(): Promise<void> {
    if (this.currentSessionId) {
      await this.client.session.abort({ path: { id: this.currentSessionId } })
    }
  }

  /**
   * Get the underlying Opencode SDK client
   */
  getClient(): OpencodeClient {
    return this.client
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.currentSessionId
  }

  /**
   * Dispose of the current session
   */
  async dispose(): Promise<void> {
    if (this.currentSessionId) {
      await this.client.session.delete({ path: { id: this.currentSessionId } })
      this.currentSessionId = null
    }
  }
}
