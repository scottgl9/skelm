/**
 * Mocked Telegram MCP server for UC1 fixture
 *
 * Simulates a Telegram bot that:
 * - Receives messages via a mock "webhook"
 * - Supports send_message and read_message tools
 * - Maintains conversation state in memory
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type McpSchema,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'

// Message state (internal type for mock)
interface MockTelegramMessage {
  messageId: number
  chatId: string
  from: string
  text: string
  timestamp: number
}

interface MockTelegramState {
  messages: MockTelegramMessage[]
  nextMessageId: number
  pendingResponses: Map<string, (text: string) => void>
}

export class MockTelegramMCP {
  private state: MockTelegramState
  private server: Server

  constructor() {
    this.state = {
      messages: [],
      nextMessageId: 1,
      pendingResponses: new Map(),
    }
    this.server = new Server(
      {
        name: 'mock-telegram-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    )
    this.setupHandlers()
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'send_message',
          description: 'Send a message to a Telegram chat',
          inputSchema: {
            type: 'object',
            properties: {
              chat_id: { type: 'string', description: 'Target chat ID' },
              text: { type: 'string', description: 'Message text' },
            },
            required: ['chat_id', 'text'],
          },
        },
        {
          name: 'read_message',
          description: 'Read pending messages from a Telegram chat',
          inputSchema: {
            type: 'object',
            properties: {
              chat_id: { type: 'string', description: 'Source chat ID' },
              limit: { type: 'number', description: 'Max messages to read', default: 10 },
            },
            required: ['chat_id'],
          },
        },
      ],
    }))

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      if (name === 'send_message') {
        const { chat_id, text } = args as { chat_id: string; text: string }
        return this.sendMessage(chat_id, text)
      }

      if (name === 'read_message') {
        const { chat_id, limit = 10 } = args as { chat_id: string; limit?: number }
        return this.readMessages(chat_id, limit)
      }

      throw new Error(`Unknown tool: ${name}`)
    })
  }

  private async sendMessage(chatId: string, text: string): Promise<McpSchema.CallToolResult> {
    const messageId = this.state.nextMessageId++
    const message: TelegramMessage = {
      messageId,
      chatId,
      from: 'bot',
      text,
      timestamp: Date.now(),
    }
    this.state.messages.push(message)

    // Check if there's a pending response handler
    const handler = this.state.pendingResponses.get(`${chatId}:${messageId}`)
    if (handler) {
      handler(text)
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, messageId, chatId }),
        },
      ],
    }
  }

  private async readMessages(chatId: string, limit: number): Promise<McpSchema.CallToolResult> {
    const chatMessages = this.state.messages.filter((m) => m.chatId === chatId).slice(-limit)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ messages: chatMessages }),
        },
      ],
    }
  }

  /**
   * Inject a simulated incoming message (for testing)
   */
  async injectMessage(chatId: string, from: string, text: string): Promise<TelegramMessage> {
    const messageId = this.state.nextMessageId++
    const message: TelegramMessage = {
      messageId,
      chatId,
      from,
      text,
      timestamp: Date.now(),
    }
    this.state.messages.push(message)
    return message
  }

  /**
   * Get all messages for a chat
   */
  getMessages(chatId: string): TelegramMessage[] {
    return this.state.messages.filter((m) => m.chatId === chatId)
  }

  /**
   * Clear all state (for test cleanup)
   */
  clear(): void {
    this.state.messages = []
    this.state.nextMessageId = 1
    this.state.pendingResponses.clear()
  }

  /**
   * Connect to a transport
   */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport)
  }

  /**
   * Close the server
   */
  async close(): Promise<void> {
    await this.server.close()
  }
}

// Export schema types for pipeline definition
export const TelegramMessageSchema = z.object({
  messageId: z.number(),
  chatId: z.string(),
  from: z.string(),
  text: z.string(),
  timestamp: z.number(),
})

export type TelegramMessage = z.infer<typeof TelegramMessageSchema>
