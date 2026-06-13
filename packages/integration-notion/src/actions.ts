/**
 * Typed Notion actions over the {@link NotionClient}.
 *
 * Each exported function shapes one Notion API request and maps the response to
 * a narrow result type. Pagination (database query, search) is driven by the
 * SDK's {@link paginate} over Notion's `next_cursor`/`has_more` envelope. None
 * of these functions touch credentials — the client already holds the resolved
 * token — so no secret material flows through this module.
 */

import { type ActionDefinition, paginate } from '@skelm/integration-sdk'
import type { NotionClient } from './client.js'

/** A Notion object id (page, database, block, user). */
export type NotionId = string

/** Opaque Notion property/value bag; shape is provider-defined per schema. */
export type NotionProperties = Readonly<Record<string, unknown>>

/** A Notion page as returned by the API (non-exhaustive, stable fields). */
export interface NotionPage {
  readonly object: 'page'
  readonly id: NotionId
  readonly url?: string
  readonly archived?: boolean
  readonly properties: NotionProperties
  readonly created_time?: string
  readonly last_edited_time?: string
}

/** A Notion block as returned by the API (non-exhaustive). */
export interface NotionBlock {
  readonly object: 'block'
  readonly id: NotionId
  readonly type: string
  readonly has_children?: boolean
}

/** Notion's paginated list envelope. */
interface NotionList<T> {
  readonly object: 'list'
  readonly results: readonly T[]
  readonly next_cursor: string | null
  readonly has_more: boolean
}

/** The current authenticated bot/user (GET /v1/users/me). */
export interface NotionUser {
  readonly object: 'user'
  readonly id: NotionId
  readonly name?: string
  readonly type?: string
}

// ---------------------------------------------------------------------------
// Action definitions (manifest surface). Permissions default-deny when omitted;
// every Notion action needs network egress.
// ---------------------------------------------------------------------------

export const NOTION_ACTIONS: readonly ActionDefinition[] = [
  {
    id: 'notion.queryDatabase',
    description: 'Query a Notion database, paginating to exhaustion.',
    requiredPermissions: ['network'],
  },
  {
    id: 'notion.createPage',
    description: 'Create a new Notion page.',
    requiredPermissions: ['network'],
  },
  {
    id: 'notion.updatePage',
    description: 'Update properties on an existing Notion page.',
    requiredPermissions: ['network'],
  },
  {
    id: 'notion.getPage',
    description: 'Retrieve a single Notion page.',
    requiredPermissions: ['network'],
  },
  {
    id: 'notion.appendBlockChildren',
    description: 'Append child blocks to a Notion block or page.',
    requiredPermissions: ['network'],
  },
  {
    id: 'notion.search',
    description: 'Search Notion pages and databases, paginating to exhaustion.',
    requiredPermissions: ['network'],
  },
]

// ---------------------------------------------------------------------------
// Query database (paginated)
// ---------------------------------------------------------------------------

export interface QueryDatabaseInput {
  readonly databaseId: NotionId
  /** Notion filter object, passed through unchanged. */
  readonly filter?: Readonly<Record<string, unknown>>
  /** Notion sorts array, passed through unchanged. */
  readonly sorts?: readonly Readonly<Record<string, unknown>>[]
  /** Page size per request (Notion caps at 100). */
  readonly pageSize?: number
  /** Cap the number of pages fetched; omit to exhaust. */
  readonly maxPages?: number
}

/** Query a database, returning every matching page across all cursors. */
export async function queryDatabase(
  client: NotionClient,
  input: QueryDatabaseInput,
): Promise<NotionPage[]> {
  const base: Record<string, unknown> = {}
  if (input.filter) base.filter = input.filter
  if (input.sorts) base.sorts = input.sorts
  if (input.pageSize !== undefined) base.page_size = input.pageSize

  const pages: NotionPage[] = []
  const iter = paginate<NotionPage>(
    async (cursor) => {
      const body = cursor === undefined ? base : { ...base, start_cursor: cursor }
      const list = await client.request<NotionList<NotionPage>>({
        method: 'POST',
        path: `/v1/databases/${encodeURIComponent(input.databaseId)}/query`,
        body,
      })
      return {
        items: list.results,
        ...(list.has_more && list.next_cursor !== null ? { nextCursor: list.next_cursor } : {}),
      }
    },
    input.maxPages !== undefined ? { maxPages: input.maxPages } : {},
  )
  for await (const page of iter) pages.push(page)
  return pages
}

// ---------------------------------------------------------------------------
// Create page
// ---------------------------------------------------------------------------

export interface CreatePageInput {
  /** Parent reference, e.g. `{ database_id }` or `{ page_id }`. */
  readonly parent: Readonly<Record<string, unknown>>
  readonly properties: NotionProperties
  /** Optional initial child blocks. */
  readonly children?: readonly Readonly<Record<string, unknown>>[]
  /** Optional page icon/cover, passed through unchanged. */
  readonly icon?: Readonly<Record<string, unknown>>
  readonly cover?: Readonly<Record<string, unknown>>
}

export function createPage(client: NotionClient, input: CreatePageInput): Promise<NotionPage> {
  const body: Record<string, unknown> = {
    parent: input.parent,
    properties: input.properties,
  }
  if (input.children) body.children = input.children
  if (input.icon) body.icon = input.icon
  if (input.cover) body.cover = input.cover
  return client.request<NotionPage>({ method: 'POST', path: '/v1/pages', body })
}

// ---------------------------------------------------------------------------
// Update page properties
// ---------------------------------------------------------------------------

export interface UpdatePageInput {
  readonly pageId: NotionId
  readonly properties?: NotionProperties
  /** Set true to archive (soft-delete) the page. */
  readonly archived?: boolean
  readonly icon?: Readonly<Record<string, unknown>>
  readonly cover?: Readonly<Record<string, unknown>>
}

export function updatePage(client: NotionClient, input: UpdatePageInput): Promise<NotionPage> {
  const body: Record<string, unknown> = {}
  if (input.properties) body.properties = input.properties
  if (input.archived !== undefined) body.archived = input.archived
  if (input.icon) body.icon = input.icon
  if (input.cover) body.cover = input.cover
  return client.request<NotionPage>({
    method: 'PATCH',
    path: `/v1/pages/${encodeURIComponent(input.pageId)}`,
    body,
  })
}

// ---------------------------------------------------------------------------
// Get page
// ---------------------------------------------------------------------------

export function getPage(client: NotionClient, pageId: NotionId): Promise<NotionPage> {
  return client.request<NotionPage>({
    method: 'GET',
    path: `/v1/pages/${encodeURIComponent(pageId)}`,
  })
}

// ---------------------------------------------------------------------------
// Append block children
// ---------------------------------------------------------------------------

export interface AppendBlockChildrenInput {
  /** Parent block or page id. */
  readonly blockId: NotionId
  readonly children: readonly Readonly<Record<string, unknown>>[]
  /** Optional id to append after, per Notion API. */
  readonly after?: NotionId
}

/** Append child blocks; returns the created child blocks. */
export async function appendBlockChildren(
  client: NotionClient,
  input: AppendBlockChildrenInput,
): Promise<NotionBlock[]> {
  const body: Record<string, unknown> = { children: input.children }
  if (input.after !== undefined) body.after = input.after
  const list = await client.request<NotionList<NotionBlock>>({
    method: 'PATCH',
    path: `/v1/blocks/${encodeURIComponent(input.blockId)}/children`,
    body,
  })
  return [...list.results]
}

// ---------------------------------------------------------------------------
// Search (paginated)
// ---------------------------------------------------------------------------

export interface SearchInput {
  readonly query?: string
  /** Notion filter object, e.g. `{ value: 'page', property: 'object' }`. */
  readonly filter?: Readonly<Record<string, unknown>>
  readonly sort?: Readonly<Record<string, unknown>>
  readonly pageSize?: number
  readonly maxPages?: number
}

/** A search result is either a page or a database object. */
export type NotionSearchResult = Readonly<Record<string, unknown>> & {
  readonly object: string
  readonly id: NotionId
}

export async function search(
  client: NotionClient,
  input: SearchInput = {},
): Promise<NotionSearchResult[]> {
  const base: Record<string, unknown> = {}
  if (input.query !== undefined) base.query = input.query
  if (input.filter) base.filter = input.filter
  if (input.sort) base.sort = input.sort
  if (input.pageSize !== undefined) base.page_size = input.pageSize

  const results: NotionSearchResult[] = []
  const iter = paginate<NotionSearchResult>(
    async (cursor) => {
      const body = cursor === undefined ? base : { ...base, start_cursor: cursor }
      const list = await client.request<NotionList<NotionSearchResult>>({
        method: 'POST',
        path: '/v1/search',
        body,
      })
      return {
        items: list.results,
        ...(list.has_more && list.next_cursor !== null ? { nextCursor: list.next_cursor } : {}),
      }
    },
    input.maxPages !== undefined ? { maxPages: input.maxPages } : {},
  )
  for await (const r of iter) results.push(r)
  return results
}
