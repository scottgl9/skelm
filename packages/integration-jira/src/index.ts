/**
 * @skelm/integration-jira
 *
 * Jira Cloud integration built on the `@skelm/integration-sdk` primitives:
 * typed issue actions, JQL search (paginated), an HMAC-verifiable issue webhook
 * with a JQL-cursor polling fallback, a health check, and an integration
 * manifest. Credentials are gateway-resolved references — this package never
 * reads `process.env` and never logs the API token.
 */

export { JiraClient, basicAuthHeader } from './client.js'
export type { JiraClientOptions, JiraResolvedCredentials } from './client.js'

export { JiraApiError, isRetryableJiraError } from './errors.js'

export {
  addComment,
  createIssue,
  getIssue,
  getMyself,
  searchIssues,
  searchIssuesAll,
  transitionIssue,
  updateIssue,
} from './actions.js'
export type {
  AddCommentParams,
  AddedComment,
  AdfDocument,
  CreatedIssue,
  CreateIssueParams,
  GetIssueParams,
  IssueBody,
  JiraIssue,
  JiraMyself,
  JqlSearchParams,
  TransitionIssueParams,
  UpdateIssueParams,
} from './actions.js'

export { checkJiraHealth } from './health.js'

export {
  JIRA_ISSUE_EVENTS,
  JIRA_SOURCE,
  buildPollJql,
  normalizeJiraWebhook,
  verifyJiraWebhook,
} from './webhook.js'
export type {
  JiraIssueEventType,
  JiraWebhookPayload,
  VerifyJiraWebhookParams,
} from './webhook.js'

export { jiraCredentialSchema, jiraManifest } from './manifest.js'
