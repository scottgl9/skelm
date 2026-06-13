/**
 * Typed Jira issue actions over {@link JiraClient}. Each function shapes the
 * REST request and maps the response into a narrow, non-secret result. Bodies
 * accept plain text (wrapped to Atlassian Document Format) or a pre-built ADF
 * document.
 */

import { type Page, paginate } from '@skelm/integration-sdk'
import type { JiraClient } from './client.js'

/** Atlassian Document Format root, used for description/comment bodies. */
export interface AdfDocument {
  readonly type: 'doc'
  readonly version: 1
  readonly content: readonly unknown[]
}

/** A body field accepted by create/update/comment: plain text or raw ADF. */
export type IssueBody = string | AdfDocument

function toAdf(body: IssueBody): AdfDocument {
  if (typeof body !== 'string') return body
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
  }
}

/** Minimal shape of a Jira issue returned by the REST API. */
export interface JiraIssue {
  readonly id: string
  readonly key: string
  readonly self: string
  readonly fields: Record<string, unknown>
}

export interface CreateIssueParams {
  readonly projectKey: string
  /** Issue type name (e.g. `Task`, `Bug`) or `{ id }`. */
  readonly issueType: string
  readonly summary: string
  readonly description?: IssueBody
  /** Additional `fields` merged verbatim (labels, assignee, custom fields). */
  readonly fields?: Record<string, unknown>
}

export interface CreatedIssue {
  readonly id: string
  readonly key: string
  readonly self: string
}

/** Create an issue. POST /issue. */
export async function createIssue(
  client: JiraClient,
  params: CreateIssueParams,
): Promise<CreatedIssue> {
  const fields: Record<string, unknown> = {
    project: { key: params.projectKey },
    issuetype: { name: params.issueType },
    summary: params.summary,
    ...(params.description !== undefined ? { description: toAdf(params.description) } : {}),
    ...params.fields,
  }
  const res = await client.request<CreatedIssue>({
    method: 'POST',
    path: '/issue',
    body: { fields },
  })
  return { id: res.id, key: res.key, self: res.self }
}

export interface GetIssueParams {
  readonly issueIdOrKey: string
  /** Restrict returned fields (e.g. `['summary', 'status']`). */
  readonly fields?: readonly string[]
}

/** Fetch a single issue. GET /issue/{idOrKey}. */
export async function getIssue(client: JiraClient, params: GetIssueParams): Promise<JiraIssue> {
  return client.request<JiraIssue>({
    method: 'GET',
    path: `/issue/${encodeURIComponent(params.issueIdOrKey)}`,
    ...(params.fields ? { query: { fields: params.fields.join(',') } } : {}),
  })
}

export interface UpdateIssueParams {
  readonly issueIdOrKey: string
  /** Fields to set (summary, description, custom fields, …). */
  readonly fields: Record<string, unknown>
}

/** Update issue fields. PUT /issue/{idOrKey} (204, no body). */
export async function updateIssue(client: JiraClient, params: UpdateIssueParams): Promise<void> {
  const fields = { ...params.fields }
  if (typeof fields.description === 'string') fields.description = toAdf(fields.description)
  await client.request<void>({
    method: 'PUT',
    path: `/issue/${encodeURIComponent(params.issueIdOrKey)}`,
    body: { fields },
  })
}

export interface TransitionIssueParams {
  readonly issueIdOrKey: string
  /** Transition id from GET /issue/{idOrKey}/transitions. */
  readonly transitionId: string
  /** Optional fields to set as part of the transition. */
  readonly fields?: Record<string, unknown>
}

/** Move an issue through a workflow transition. POST /issue/{idOrKey}/transitions. */
export async function transitionIssue(
  client: JiraClient,
  params: TransitionIssueParams,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: `/issue/${encodeURIComponent(params.issueIdOrKey)}/transitions`,
    body: {
      transition: { id: params.transitionId },
      ...(params.fields ? { fields: params.fields } : {}),
    },
  })
}

export interface AddCommentParams {
  readonly issueIdOrKey: string
  readonly body: IssueBody
}

export interface AddedComment {
  readonly id: string
  readonly self: string
}

/** Add a comment to an issue. POST /issue/{idOrKey}/comment. */
export async function addComment(
  client: JiraClient,
  params: AddCommentParams,
): Promise<AddedComment> {
  const res = await client.request<AddedComment>({
    method: 'POST',
    path: `/issue/${encodeURIComponent(params.issueIdOrKey)}/comment`,
    body: { body: toAdf(params.body) },
  })
  return { id: res.id, self: res.self }
}

export interface JqlSearchParams {
  readonly jql: string
  /** Page size; Jira caps this server-side. Defaults to 50. */
  readonly maxResults?: number
  readonly fields?: readonly string[]
  /** Stop after this many pages. Unbounded when omitted. */
  readonly maxPages?: number
}

interface JiraSearchResponse {
  readonly issues?: readonly JiraIssue[]
  /** Token-based cursor (Jira Cloud `/search/jql`). */
  readonly nextPageToken?: string
}

/**
 * Run a JQL search, paginating to exhaustion via the SDK `paginate` helper.
 * Uses the token-cursor `/search/jql` endpoint and yields each issue.
 */
export async function* searchIssues(
  client: JiraClient,
  params: JqlSearchParams,
): AsyncGenerator<JiraIssue, void, void> {
  const fetchPage = async (cursor: string | undefined): Promise<Page<JiraIssue>> => {
    const res = await client.request<JiraSearchResponse>({
      method: 'POST',
      path: '/search/jql',
      body: {
        jql: params.jql,
        maxResults: params.maxResults ?? 50,
        ...(params.fields ? { fields: params.fields } : {}),
        ...(cursor !== undefined ? { nextPageToken: cursor } : {}),
      },
    })
    return {
      items: res.issues ?? [],
      ...(res.nextPageToken !== undefined ? { nextCursor: res.nextPageToken } : {}),
    }
  }
  yield* paginate(fetchPage, params.maxPages !== undefined ? { maxPages: params.maxPages } : {})
}

/** Convenience: collect a JQL search into an array (bounded by `maxPages`). */
export async function searchIssuesAll(
  client: JiraClient,
  params: JqlSearchParams,
): Promise<JiraIssue[]> {
  const out: JiraIssue[] = []
  for await (const issue of searchIssues(client, params)) out.push(issue)
  return out
}

/** Shape returned by the health check (GET /myself). */
export interface JiraMyself {
  readonly accountId: string
  readonly emailAddress?: string
  readonly displayName?: string
}

/** Verify credentials against GET /myself. */
export async function getMyself(client: JiraClient): Promise<JiraMyself> {
  return client.request<JiraMyself>({ method: 'GET', path: '/myself' })
}
