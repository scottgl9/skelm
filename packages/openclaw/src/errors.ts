/**
 * Typed errors for the OpenClaw host bridge.
 *
 * The bridge is a thin client over the gateway HTTP surface, so its errors are
 * about the bridge↔gateway boundary: unknown workflows, failed gateway calls,
 * and unauthorized/auth-failure responses. No error here ever carries a
 * resolved bearer token — only the credential reference's `secretName`.
 */

export class OpenClawBridgeError extends Error {
  override readonly name: string = 'OpenClawBridgeError'
}

/** The requested workflow id is not registered on the gateway (HTTP 404). */
export class UnknownWorkflowError extends OpenClawBridgeError {
  override readonly name = 'UnknownWorkflowError'
  readonly workflowId: string
  constructor(workflowId: string) {
    super(`unknown workflow: ${workflowId}`)
    this.workflowId = workflowId
  }
}

/** A gateway HTTP call returned a non-2xx status the bridge cannot interpret. */
export class GatewayRequestError extends OpenClawBridgeError {
  override readonly name: string = 'GatewayRequestError'
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** The gateway rejected the bearer credential (HTTP 401/403). */
export class GatewayAuthError extends GatewayRequestError {
  override readonly name = 'GatewayAuthError'
  constructor(status: number) {
    super(`gateway rejected bearer credential (status ${status})`, status)
  }
}
