/**
 * @skelm/integration-notion
 *
 * Typed Notion API actions built on `@skelm/integration-sdk` primitives. Every
 * request goes through the SDK's egress-gated `httpRequest`, sends the required
 * `Notion-Version` header, and authenticates with a gateway-resolved
 * integration token that this package never reads from the environment, holds
 * beyond a dispatch, or logs.
 */

// Transport
export {
  createNotionClient,
  NotionApiError,
  NOTION_API_BASE,
  NOTION_VERSION,
} from './client.js'
export type {
  NotionAuth,
  NotionClient,
  NotionClientOptions,
  NotionRequest,
} from './client.js'

// Actions
export {
  appendBlockChildren,
  createPage,
  getPage,
  NOTION_ACTIONS,
  queryDatabase,
  search,
  updatePage,
} from './actions.js'
export type {
  AppendBlockChildrenInput,
  CreatePageInput,
  NotionBlock,
  NotionId,
  NotionPage,
  NotionProperties,
  NotionSearchResult,
  NotionUser,
  QueryDatabaseInput,
  SearchInput,
  UpdatePageInput,
} from './actions.js'

// Health
export { getCurrentUser } from './health.js'

// Manifest + health/fixtures
export {
  checkHealth,
  notionManifest,
  NOTION_AUDIT_REDACTION,
  NOTION_CREDENTIAL_SCHEMA,
  NOTION_DASHBOARD,
  NOTION_INTEGRATION_ID,
  NOTION_LIVE_TEST,
  NOTION_MOCK_FIXTURE,
} from './manifest.js'
