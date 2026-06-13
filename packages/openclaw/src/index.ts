/**
 * @skelm/openclaw
 *
 * Host-bridge package: exposes OpenClaw-style tools that map onto skelm's
 * gateway HTTP API. The bridge is a thin typed client — it owns no execution,
 * permission enforcement, secret resolution, or audit; the gateway owns all of
 * that. Credentials are referenced (never read from `process.env`, never
 * logged); run/task/audit references are preserved end-to-end from an inbound
 * message through the run to the delivered reply.
 */

// Gateway HTTP client seam (injectable; default fetch-backed)
export { createGatewayClient } from './client.js'
export type {
  GatewayRequest,
  GatewayResponse,
  GatewayHttpClient,
  GatewayClientOptions,
  BearerResolver,
} from './client.js'

// Bridge tools
export {
  skelmRun,
  skelmStart,
  skelmStatus,
  skelmCancel,
  skelmAudit,
  skelmWorkflowSearch,
} from './tools.js'
export type {
  AuditRefs,
  ToolResult,
  RunToolInput,
  StartToolInput,
  StatusToolInput,
  CancelToolInput,
  AuditToolInput,
  WorkflowSearchInput,
} from './tools.js'

// Inbound normalization (OpenClaw message/event → trigger input)
export { normalizeInbound } from './inbound.js'
export type { NormalizedTriggerInput, NormalizedInbound } from './inbound.js'

// Outbound delivery (result → DeliveryTarget, carrying audit refs)
export { resultToOutbound, deliverResult, targetToConversation } from './delivery.js'
export type { Deliver, DeliveryMappingOptions } from './delivery.js'

// Manifest
export { openclawManifest, gatewayBearerCredential } from './manifest.js'

// Errors
export {
  OpenClawBridgeError,
  UnknownWorkflowError,
  GatewayRequestError,
  GatewayAuthError,
} from './errors.js'

// Deterministic testing seam + self-test
export { FakeGatewayClient } from './testing.js'
export type { RecordedRequest, CannedResponse } from './testing.js'
export { runSelfTest, OpenClawSelfTestError } from './self-test.js'
export type { SelfTestReport } from './self-test.js'
