// JSON-RPC stdio transport with Content-Length framing.
//
// Reads/writes JSON-RPC messages over a Readable/Writable pair. Frames use
// the LSP-style `Content-Length: <n>\r\n\r\n<payload>` header. The transport
// is full-duplex and dispatches three event types:
//   - 'request'      — peer sent a request (rare for us; we are the client).
//   - 'notification' — peer sent a notification (e.g. session/update).
//   - 'response'     — peer answered one of our requests.

import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './protocol.js'

type AnyMessage = (JsonRpcRequest & { id: number | string }) | JsonRpcNotification | JsonRpcResponse

export class JsonRpcStdioTransport extends EventEmitter {
  private buffer = Buffer.alloc(0)

  constructor(
    private readonly stdout: Readable,
    private readonly stdin: Writable,
  ) {
    super()
    stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    stdout.on('error', (err) => this.emit('error', err))
    stdout.on('close', () => this.emit('close'))
  }

  /** Send a JSON-RPC request, notification, or response. */
  send(message: AnyMessage): void {
    const payload = JSON.stringify(message)
    const body = Buffer.from(payload, 'utf8')
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
    this.stdin.write(Buffer.concat([header, body]))
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.slice(0, headerEnd).toString('ascii')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match || !match[1]) {
        // Drop malformed framing; we can't recover the stream alignment.
        this.emit('error', new Error('ACP transport: missing Content-Length header'))
        this.buffer = Buffer.alloc(0)
        return
      }
      const length = Number.parseInt(match[1], 10)
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.slice(start, start + length).toString('utf8')
      this.buffer = this.buffer.slice(start + length)
      this.dispatch(body)
    }
  }

  private dispatch(payload: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch (err) {
      this.emit('error', new Error(`ACP transport: invalid JSON: ${(err as Error).message}`))
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.emit('error', new Error('ACP transport: expected object payload'))
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
