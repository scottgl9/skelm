import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './protocol.js'

type AnyMessage = (JsonRpcRequest & { id: number | string }) | JsonRpcNotification | JsonRpcResponse

export class JsonRpcLineTransport extends EventEmitter {
  private buffer = ''

  constructor(
    private readonly stdout: Readable,
    private readonly stdin: Writable,
  ) {
    super()
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => this.onData(chunk))
    stdout.on('error', (err) => this.emit('error', err))
    stdout.on('close', () => this.emit('close'))
  }

  send(message: AnyMessage): void {
    this.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) return
      const line = this.buffer.slice(0, newline).replace(/\r$/, '').trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length === 0) continue
      this.dispatch(line)
    }
  }

  private dispatch(payload: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch (err) {
      this.emit('error', new Error(`MCP transport: invalid JSON: ${(err as Error).message}`))
      return
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) this.dispatchMessage(item)
      return
    }
    this.dispatchMessage(parsed)
  }

  private dispatchMessage(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null) {
      this.emit('error', new Error('MCP transport: expected object payload'))
      return
    }
    const obj = parsed as Record<string, unknown>
    if ('method' in obj && 'id' in obj) {
      this.emit('request', obj as unknown as JsonRpcRequest)
    } else if ('method' in obj) {
      this.emit('notification', obj as unknown as JsonRpcNotification)
    } else if ('id' in obj) {
      this.emit('response', obj as unknown as JsonRpcResponse)
    }
  }
}
